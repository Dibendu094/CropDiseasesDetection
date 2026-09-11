import { useId, type ReactNode } from "react";

import type { CandidateOut, PredictResponse } from "../../api/types";
import { useReducedMotion } from "../../hooks/useReducedMotion";
import { formatConfidence, formatTimestamp } from "../../lib/format";
import { reportInputFromPrediction } from "../../lib/report";
import { Card, EmptyState, ErrorNotice, Spinner } from "../ui";
import { DiagnosisHeader } from "./DiagnosisHeader";
import { DownloadReportButton } from "./DownloadReportButton";
import { HealthyResult } from "./HealthyResult";
import { PlaceholderNotice } from "./PlaceholderNotice";
import { RecommendationSections } from "./RecommendationSections";
import { UncertaintyBanner } from "./UncertaintyBanner";

/**
 * The result panel: one of five states, exactly one at a time (Req 5.7, 10.7, 10.8, 11.5, 11.6).
 *
 * **Req 5.7 is enforced by the type, not by the markup.** The props are a discriminated union over
 * `state`, and the `success` arm carries a single `PredictResponse`. There is no array of results, no
 * "primary" and "backup" pair, and therefore no shape in which two model results could be rendered
 * side by side. The two-model fallback is entirely a backend concern; what arrives here is one
 * diagnosis.
 *
 * **No model identity is rendered anywhere in this panel.** Which checkpoint answered, which
 * checkpoints ran, and how many milliseconds it took are implementation details a grower cannot act
 * on, and naming them invites the question "can I have the other model's answer?" — which the product
 * deliberately does not offer. `diagnosis.model_used` and `meta.models_run` stay in the types and in
 * the payload for logs and debugging; they are simply not shown.
 *
 * The same union makes the other four states mutually exclusive. `error` and `unreachable` both
 * require a `message` *and* an `onRetry`, so a failure can never render without a way forward
 * (Req 10.7) — the retry control is always enabled, since `retrying` only reflects a second attempt
 * already in flight. `unreachable` differs from `error` only in its heading: the message it displays
 * is the client's `UNREACHABLE_MESSAGE`, as sent (Req 10.8).
 *
 * **The entrance is staggered in JavaScript, so it is gated in JavaScript.** Each block fades up
 * 60 ms after the one before it, capped at 4 steps: the last block starts at most 240 ms late, which
 * with the 420 ms `fade-in-up` keeps every section inside the 500 ms ceiling of Req 11.5 relative to
 * its own start. `useReducedMotion` drops both the delay and the animation class — the global CSS
 * block collapses *durations*, but a 240 ms delay is not a duration, and honouring the preference
 * means the content appears immediately rather than after a quarter of a second of nothing (Req 11.6).
 *
 * The success body also carries the top-3 candidates (Req 5.5), the scan timestamp as small print, and
 * the control that saves the whole diagnosis as a printable report. The report control sits in the
 * first block, immediately under the diagnosis header, because that is where a user decides they want
 * to keep this result — not after scrolling twelve guidance sections.
 *
 * No live region here. The `DiagnosisPage` owns the single `LiveRegion` that announces the result and
 * the error (Req 12.6); announcing from inside the panel as well would speak everything twice.
 */

/** Delay added per block. */
export const STAGGER_STEP_MS = 60;

/** Hard cap on the stagger, in steps: block 5 and beyond share block 5's delay. */
export const MAX_STAGGER_STEPS = 4;

/** Heading over the failure panel when the backend could not be reached at all (Req 10.8). */
export const UNREACHABLE_TITLE = "Server unreachable";

/** Heading over the failure panel when the backend answered with an error (Req 10.7). */
export const ERROR_TITLE = "Diagnosis failed";

/** The five states, exactly one of which is rendered. */
export type ResultState = "idle" | "pending" | "success" | "error" | "unreachable";

interface ResultBoxCommonProps {
  /** Extra classes for the wrapper. */
  className?: string;
}

/** Nothing submitted yet. */
export interface ResultBoxIdleProps extends ResultBoxCommonProps {
  state: "idle";
}

/** A prediction is in flight (Req 6.7 gives it 60 seconds). */
export interface ResultBoxPendingProps extends ResultBoxCommonProps {
  state: "pending";
}

/** One prediction, for one image, from one model. */
export interface ResultBoxSuccessProps extends ResultBoxCommonProps {
  state: "success";
  result: PredictResponse;
  /**
   * The photo that produced this result, embedded in the downloadable report.
   *
   * Optional because the panel is useful without it: a caller that no longer holds the `File` — a
   * remount, a result restored from elsewhere — still gets a report, just without the image. The
   * response's `image_url` is not a substitute; it points at the server, and the report has to stay
   * readable offline.
   */
  file?: File;
}

/** A failed request: the backend's message, or the client's for an unreachable server. */
export interface ResultBoxFailureProps extends ResultBoxCommonProps {
  state: "error" | "unreachable";
  /** `ApiClientError.message`, rendered verbatim — the backend's wording wins (Req 10.7). */
  message: string;
  /** Required: an error with no way forward is where a user gets stuck. */
  onRetry: () => void;
  /** A retry is already in flight. */
  retrying?: boolean;
}

export type ResultBoxProps =
  | ResultBoxIdleProps
  | ResultBoxPendingProps
  | ResultBoxSuccessProps
  | ResultBoxFailureProps;

/** One staggered block. `index` is its position among the blocks actually rendered. */
function Reveal({
  index,
  reduced,
  children,
}: {
  index: number;
  reduced: boolean;
  children: ReactNode;
}): JSX.Element {
  if (reduced) return <div>{children}</div>;

  const step = Math.min(index, MAX_STAGGER_STEPS);
  return (
    <div
      className="animate-fade-in-up"
      style={{ animationDelay: `${String(step * STAGGER_STEP_MS)}ms` }}
    >
      {children}
    </div>
  );
}

/** The top-3 candidates, highest first (Req 5.5). */
function CandidateList({ candidates }: { candidates: readonly CandidateOut[] }): JSX.Element {
  const headingId = useId();

  return (
    <Card as="section" data-testid="candidate-list" aria-labelledby={headingId}>
      <h3 id={headingId} className="text-h3 text-ink-900">
        Top candidates
      </h3>
      <p className="mt-1 wrap-anywhere text-small text-ink-500">
        The most likely classes, highest confidence first. The diagnosis above is the first of them.
      </p>
      <ol className="mt-3 space-y-2">
        {candidates.map((candidate, index) => (
          <li
            key={`${candidate.label}-${String(index)}`}
            className="flex items-baseline justify-between gap-3 border-t border-stone-200 pt-2 first:border-0 first:pt-0"
          >
            <span className="wrap-anywhere text-body text-ink-700">
              {candidate.display_name.trim() === "" ? candidate.label : candidate.display_name}
            </span>
            {/* `confidence` is a bare softmax fraction here, so it is converted, not re-derived from
                a percentage the backend already computed. */}
            <span className="numeric shrink-0 text-small font-semibold text-ink-700">
              {formatConfidence(candidate.confidence)}
            </span>
          </li>
        ))}
      </ol>
    </Card>
  );
}

/**
 * When the scan was taken — the small print under the result.
 *
 * The timestamp is all of it. The models that ran and the inference cost used to sit here, and both
 * are gone: neither changes what a grower does next, and the model names in particular pushed an
 * implementation detail into a decision surface. The fields remain in `meta` for logs.
 */
function ResultMeta({ createdAt }: { createdAt: string }): JSX.Element {
  return (
    <p data-testid="result-meta" className="numeric text-small text-ink-500">
      <time dateTime={createdAt}>{formatTimestamp(createdAt)}</time>
    </p>
  );
}

/** The success body, split out so the stagger indices are visible in one list. */
function SuccessResult({
  result,
  reduced,
  file,
}: {
  result: PredictResponse;
  reduced: boolean;
  file?: File;
}): JSX.Element {
  const { diagnosis, recommendation, candidates } = result;

  const blocks: { key: string; node: ReactNode }[] = [
    {
      key: "header",
      node: (
        <>
          <DiagnosisHeader diagnosis={diagnosis} accent={diagnosis.is_healthy ? "leaf" : "plain"} />
          {/* Directly under the header: the moment a user has read the diagnosis is the moment they
              decide to keep it. `file` may be absent, in which case the report carries no photo. */}
          <DownloadReportButton
            className="mt-3"
            input={reportInputFromPrediction(result)}
            {...(file === undefined ? {} : { file })}
          />
        </>
      ),
    },
  ];

  // Both notices also self-guard; the condition here keeps a `null` block from taking a stagger slot
  // and a `space-y` gap with nothing in it.
  if (diagnosis.is_uncertain) {
    blocks.push({ key: "uncertainty", node: <UncertaintyBanner isUncertain /> });
  }
  if (recommendation.is_placeholder) {
    blocks.push({ key: "placeholder", node: <PlaceholderNotice isPlaceholder /> });
  }

  blocks.push({
    key: "guidance",
    node: diagnosis.is_healthy ? (
      <HealthyResult diagnosis={diagnosis} recommendation={recommendation} />
    ) : (
      <RecommendationSections recommendation={recommendation} />
    ),
  });

  if (candidates.length > 0) {
    blocks.push({
      key: "candidates",
      node: <CandidateList candidates={candidates} />,
    });
  }

  blocks.push({
    key: "meta",
    node: <ResultMeta createdAt={result.created_at} />,
  });

  return (
    <div data-testid="result-success" className="space-y-4">
      {blocks.map((block, index) => (
        <Reveal key={block.key} index={index} reduced={reduced}>
          {block.node}
        </Reveal>
      ))}
    </div>
  );
}

export function ResultBox(props: ResultBoxProps): JSX.Element {
  // Called unconditionally, before any branch: the state can change between renders.
  const reduced = useReducedMotion();

  return (
    <div
      data-testid="result-box"
      data-state={props.state}
      className={["w-full", props.className].filter(Boolean).join(" ")}
    >
      {renderState(props, reduced)}
    </div>
  );
}

/**
 * The state machine itself. A `switch` over the discriminant returns exactly one node, and TypeScript
 * checks the arms against the union — a sixth state cannot be added without a branch for it.
 */
function renderState(props: ResultBoxProps, reduced: boolean): JSX.Element {
  switch (props.state) {
    case "idle":
      return (
        <EmptyState
          title="No diagnosis yet"
          description="Add a photo of the affected leaf above and submit it. The diagnosis, its confidence, and the treatment guidance will appear here."
        />
      );

    case "pending":
      return (
        <Card className="overflow-hidden">
          {/* Shimmer header skeleton */}
          <div className="relative overflow-hidden rounded-xl bg-stone-100 p-5 sm:p-6 mb-4">
            <div className="h-7 w-2/3 rounded-lg bg-stone-200 mb-3" />
            <div className="h-4 w-1/3 rounded-lg bg-stone-200 mb-5" />
            <div className="h-2.5 w-full rounded-full bg-stone-200" />
            <div aria-hidden="true" className="shimmer absolute inset-0 rounded-xl" />
          </div>
          {/* Spinner + label */}
          <div className="flex flex-col items-center gap-3 py-6 text-center">
            <Spinner size="lg" label="Analysing photo…" showLabel />
            <p className="text-small text-ink-400 max-w-xs">
              On a CPU this usually takes a few seconds, and up to 35 when the second model is
              consulted.
            </p>
          </div>
        </Card>
      );

    case "success":
      return (
        <SuccessResult
          result={props.result}
          reduced={reduced}
          {...(props.file === undefined ? {} : { file: props.file })}
        />
      );

    case "error":
    case "unreachable":
      return (
        <ErrorNotice
          title={props.state === "unreachable" ? UNREACHABLE_TITLE : ERROR_TITLE}
          message={props.message}
          onRetry={props.onRetry}
          retrying={props.retrying ?? false}
          retryLabel="Try again"
        />
      );
  }
}

export default ResultBox;
