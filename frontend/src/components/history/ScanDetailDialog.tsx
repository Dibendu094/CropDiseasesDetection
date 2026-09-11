import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";

import { api } from "../../api/client";
import { GENERIC_ERROR_MESSAGE, isApiClientError } from "../../api/errors";
import type { DiagnosisOut, HistoryItem, ScanDetail } from "../../api/types";
import { formatTimestamp } from "../../lib/format";
import type { ReportInput } from "../../lib/report";
import {
  DiagnosisHeader,
  DownloadReportButton,
  HealthyResult,
  PlaceholderNotice,
  RecommendationSections,
  UncertaintyBanner,
} from "../result";
import { Button, ErrorNotice, Spinner } from "../ui";

/**
 * A saved scan in full, as a modal over the history grid: the stored photo, the diagnosis, the
 * caveats that applied to it, the whole guidance block, and a report download (Req 9.7, 7.9, 7.11).
 *
 * **Why a dialog and not a route.** The grid is the context. A grower scanning a list of a dozen
 * entries wants to look inside one and get back to the list they were reading, and a modal keeps the
 * list underneath rather than replacing it and forcing a re-fetch on the way back.
 *
 * **Why the modal contract is reimplemented rather than imported.** This follows
 * `ui/ConfirmDialog`'s implementation closely and on purpose — `role="dialog"`, `aria-modal="true"`,
 * `aria-labelledby` off the visible title, a Tab/Shift+Tab focus trap, focus restored to whatever was
 * focused when it opened (the View button of the row, which the page focuses before opening), Escape
 * as the single close path, and a body scroll lock that puts the previous value back. What it does
 * *not* do is reuse `ConfirmDialog`: that component is a question with two answers, and bending a
 * confirmation into a content container would mean a `children` prop, a hidden confirm button, and a
 * dialog whose accessible name is a question nobody asked. Two behaviours, two components.
 *
 * **Why the detail is fetched here and not with the list.** `GET /api/history` deliberately omits the
 * candidates and the recommendation — a dozen 12-section guidance blocks is a payload nobody reads.
 * `api.scan` is called when the dialog opens, keyed on the scan id and a retry token, so it runs once
 * per opened scan rather than once per render (Req 9.2).
 *
 * **Why the photo is fetched a second time for the report.** The report is a standalone file with no
 * external requests, so the photo has to travel inside it as a `data:` URL. The history page holds no
 * `File` — only an id — so {@link fetchImageDataUrl} pulls the stored bytes and reads them into a
 * data URL. That read is independent of the download: if it fails, the button still produces the
 * document without the photo, because the treatment table is the reason anyone saves it.
 *
 * **Why the body scrolls rather than the page.** A full recommendation runs to twelve sections. With
 * the panel capped at 90 % of the viewport and only its middle scrolling, the title and the Close
 * control stay on screen the whole way down — a dialog whose only exit has scrolled off is a trap in
 * everything but name.
 */

/** Tab stops inside the dialog, as in `ConfirmDialog`. `:not([disabled])` drops a busy control. */
const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

/** Reserves the photo's space up front; matches the `width`/`height` ratio on the `<img>`. */
const IMAGE_WIDTH = 960;
const IMAGE_HEIGHT = 720;

/** Shown while the detail is in flight. */
export const SCAN_DETAIL_LOADING_LABEL = "Loading this scan…";

/** Panel heading when the detail could not be loaded. */
export const SCAN_DETAIL_ERROR_TITLE = "This scan could not be opened";

/**
 * Fetch a stored scan image and read it into a `data:` URL for the report to embed.
 *
 * `lib/report.ts`'s `fileToDataUrl` takes the `File` the diagnosis page still holds; the history page
 * has an id and a URL, so the bytes are fetched first. `FileReader` rather than
 * `URL.createObjectURL`, for the same reason as there: an object URL dies with the document that made
 * it, and the report is meant to outlive it.
 *
 * Rejects on a non-2xx response or an unreadable blob. The caller treats either as "no photo".
 */
export async function fetchImageDataUrl(id: string): Promise<string> {
  const response = await fetch(api.imageUrl(id));
  if (!response.ok) throw new Error("The stored photo could not be loaded.");

  const blob = await response.blob();
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => {
      reject(new Error("The stored photo could not be read."));
    };
    reader.onload = () => {
      const result = reader.result;
      if (typeof result === "string") resolve(result);
      else reject(new Error("The stored photo could not be read."));
    };
    reader.readAsDataURL(blob);
  });
}

/**
 * Rebuild a `DiagnosisOut` from a stored row, so the existing result components render it unchanged.
 *
 * Every field the header and the healthy variant read is stored on the scan; `label` is not, because
 * the row keeps the resolved display name instead. Nothing rendered reads `label`, so the display
 * name stands in rather than an empty string that would look like missing data in a debugger.
 */
function diagnosisFromDetail(detail: ScanDetail): DiagnosisOut {
  return {
    label: detail.display_name,
    display_name: detail.display_name,
    crop: detail.crop,
    crop_hindi: detail.crop_hindi,
    disease: detail.disease,
    is_healthy: detail.is_healthy,
    confidence: detail.confidence,
    // The backend's computed percentage, passed through — never re-derived (Req 11.7).
    confidence_percent: detail.confidence_percent,
    model_used: detail.model_used,
    is_uncertain: detail.is_uncertain,
  };
}

export interface ScanDetailDialogProps {
  /** Whether the dialog is mounted and visible. Nothing renders when `false`. */
  open: boolean;
  /**
   * The row that was opened, `null` when the dialog is closed. Supplies the id to fetch and gives the
   * dialog an accessible name and a photo before the detail lands.
   */
  item: HistoryItem | null;
  /** Called on Close, Escape, and a backdrop click. The single close path. */
  onClose: () => void;
  /** Whether a click on the backdrop closes. Defaults to `true`. */
  dismissOnBackdrop?: boolean;
  /** Extra classes for the dialog panel. */
  className?: string;
}

export function ScanDetailDialog({
  open,
  item,
  onClose,
  dismissOnBackdrop = true,
  className,
}: ScanDetailDialogProps): JSX.Element | null {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);

  const [detail, setDetail] = useState<ScanDetail | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  /** The stored photo as a `data:` URL for the report, or `null` when it could not be read. */
  const [imageDataUrl, setImageDataUrl] = useState<string | null>(null);
  /** Bumped by Retry; part of the fetch effect's dependencies, which is what re-runs it. */
  const [attempt, setAttempt] = useState<number>(0);

  const scanId = item === null ? null : item.id;

  useEffect(() => {
    if (!open || scanId === null) return;

    // Local flag rather than a component-level ref: closing, or opening a different row, must not
    // let the previous response land on the new one.
    let active = true;
    setLoading(true);
    setError(null);
    setDetail(null);

    void (async () => {
      try {
        const result = await api.scan(scanId);
        if (!active) return;
        setDetail(result);
      } catch (e) {
        if (!active) return;
        // Every `api.*` failure is an `ApiClientError` carrying the backend's own wording (Req 10.7).
        setError(isApiClientError(e) ? e.message : GENERIC_ERROR_MESSAGE);
      } finally {
        if (active) setLoading(false);
      }
    })();

    return () => {
      active = false;
    };
  }, [open, scanId, attempt]);

  useEffect(() => {
    if (!open || scanId === null) return;

    let active = true;
    setImageDataUrl(null);

    void (async () => {
      try {
        const dataUrl = await fetchImageDataUrl(scanId);
        if (active) setImageDataUrl(dataUrl);
      } catch {
        // No photo in the report, and nothing said about it: the guidance is the document.
        if (active) setImageDataUrl(null);
      }
    })();

    return () => {
      active = false;
    };
  }, [open, scanId]);

  useEffect(() => {
    if (!open) return;

    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const { body } = document;
    const previousOverflow = body.style.overflow;
    body.style.overflow = "hidden";

    // Effects run after commit, so Close already exists. The panel is the fallback for the
    // theoretical case where the button did not render.
    (closeRef.current ?? dialogRef.current)?.focus();

    return () => {
      body.style.overflow = previousOverflow;
      // The row's View button survives a detail view — unlike a delete — but the guard stays: a
      // detached node cannot take focus, and trying throws the focus position away entirely.
      if (previouslyFocused?.isConnected === true) {
        previouslyFocused.focus();
      }
    };
  }, [open]);

  const focusableNodes = useCallback((): readonly HTMLElement[] => {
    const dialog = dialogRef.current;
    if (!dialog) return [];
    return [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)];
  }, []);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>): void => {
      if (event.key === "Escape") {
        // Stop here: an Escape meant for the dialog must not also close something behind it.
        event.stopPropagation();
        onClose();
        return;
      }

      if (event.key !== "Tab") return;

      const nodes = focusableNodes();
      // Indexed rather than `at()`: the `ES2020` lib target does not declare it.
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (!first || !last) {
        // Nothing to move to — keep focus here rather than letting Tab leave the dialog.
        event.preventDefault();
        return;
      }

      const active = document.activeElement;
      const inside = active instanceof Node && dialogRef.current?.contains(active) === true;

      if (event.shiftKey) {
        if (!inside || active === first) {
          event.preventDefault();
          last.focus();
        }
        return;
      }

      if (!inside || active === last) {
        event.preventDefault();
        first.focus();
      }
    },
    [focusableNodes, onClose],
  );

  const retry = useCallback((): void => {
    setAttempt((token) => token + 1);
  }, []);

  /**
   * The report's input, flattened off the scan detail — the same struct
   * `reportInputFromPrediction` produces for the diagnosis path.
   *
   * `cropFilter` is `null` because the stored row does not keep it: a scan run with the crop picker
   * set and one run without are indistinguishable afterwards, and printing a guess would be worse
   * than printing nothing. Memoised so a new object on every render does not restart
   * `DownloadReportButton`'s work.
   */
  const reportInput = useMemo<ReportInput | null>(() => {
    if (detail === null) return null;
    return {
      displayName: detail.display_name,
      crop: detail.crop,
      cropHindi: detail.crop_hindi,
      disease: detail.disease,
      isHealthy: detail.is_healthy,
      confidencePercent: detail.confidence_percent,
      isUncertain: detail.is_uncertain,
      createdAt: detail.created_at,
      cropFilter: null,
      candidates: detail.candidates,
      recommendation: detail.recommendation,
      ...(imageDataUrl === null ? {} : { imageDataUrl }),
    };
  }, [detail, imageDataUrl]);

  if (!open || item === null) return null;

  const when = formatTimestamp(item.created_at);

  return (
    <div
      data-testid="scan-detail-overlay"
      // `ink.900` at 60%, as on `ConfirmDialog`: the grid reads as inert without disappearing.
      className="fixed inset-0 z-50 flex animate-fade-in items-end justify-center bg-ink-900/60 p-4 sm:items-center"
      onClick={(event) => {
        if (dismissOnBackdrop && event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={handleKeyDown}
        // Focusable as a fallback target only, and never in the Tab order. No `outline: none` — a
        // focus target without a visible ring is exactly what Req 12.4 rules out.
        tabIndex={-1}
        data-testid="scan-detail-dialog"
        className={[
          "flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden",
          "animate-fade-in-up rounded-2xl bg-white shadow-md",
          className,
        ]
          .filter(Boolean)
          .join(" ")}
      >
        {/* `shrink-0`: the header keeps its height so only the body gives way to a long guidance. */}
        <div className="flex shrink-0 items-start justify-between gap-3 border-b border-stone-200 p-5 sm:p-6">
          <div className="min-w-0">
            <h2 id={titleId} className="wrap-anywhere text-h3 text-ink-900">
              {item.display_name}
            </h2>
            <time dateTime={item.created_at} className="numeric text-caption text-ink-500">
              {when}
            </time>
          </div>
          <Button
            variant="secondary"
            size="sm"
            buttonRef={closeRef}
            onClick={onClose}
            aria-label={`Close the details of the scan from ${when} diagnosed as ${item.display_name}`}
          >
            Close
          </Button>
        </div>

        {/* The one scrolling region. `min-h-0` is what lets a flex child actually shrink. */}
        <div
          data-testid="scan-detail-body"
          className="min-h-0 flex-1 space-y-4 overflow-y-auto p-5 sm:p-6"
        >
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Spinner size="lg" label={SCAN_DETAIL_LOADING_LABEL} showLabel />
            </div>
          ) : error !== null ? (
            <ErrorNotice
              title={SCAN_DETAIL_ERROR_TITLE}
              message={error}
              onRetry={retry}
              retryLabel="Retry"
            >
              Nothing has been changed or deleted. Retry, or close this and pick another scan.
            </ErrorNotice>
          ) : detail !== null ? (
            <>
              {/* `stone.100` behind the reserved box, so it reads as a surface and not a hole. */}
              <div className="aspect-[4/3] w-full overflow-hidden rounded-xl bg-stone-100">
                <img
                  src={api.imageUrl(detail.id)}
                  alt={`Scan from ${when} diagnosed as ${detail.display_name}`}
                  width={IMAGE_WIDTH}
                  height={IMAGE_HEIGHT}
                  decoding="async"
                  className="h-full w-full object-cover"
                />
              </div>

              <DiagnosisHeader
                diagnosis={diagnosisFromDetail(detail)}
                accent={detail.is_healthy ? "leaf" : "plain"}
              />

              {/* Both test their own flag and render nothing when it is false (Req 5.6, 7.8). */}
              <UncertaintyBanner isUncertain={detail.is_uncertain} />
              <PlaceholderNotice isPlaceholder={detail.recommendation.is_placeholder} />

              {detail.is_healthy ? (
                <HealthyResult
                  diagnosis={diagnosisFromDetail(detail)}
                  recommendation={detail.recommendation}
                />
              ) : (
                <RecommendationSections recommendation={detail.recommendation} />
              )}
            </>
          ) : null}
        </div>

        {/* Outside the scrolling body, so the download stays reachable at any scroll position. */}
        {reportInput === null ? null : (
          <div className="shrink-0 border-t border-stone-200 p-4 sm:px-6">
            <DownloadReportButton input={reportInput} />
          </div>
        )}
      </div>
    </div>
  );
}

export default ScanDetailDialog;
