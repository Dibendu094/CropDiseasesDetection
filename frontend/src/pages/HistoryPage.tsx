import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";

import type { HistoryItem } from "../api/types";
import { HistoryGrid } from "../components/history/HistoryGrid";
import { ScanDetailDialog } from "../components/history/ScanDetailDialog";
import {
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  ErrorNotice,
  LiveRegion,
  SectionHeading,
  Spinner,
} from "../components/ui";
import { useHistory } from "../hooks/useHistory";
import { formatTimestamp } from "../lib/format";

/**
 * The saved scans, newest first, each one openable in full and each one deletable behind a
 * confirmation (Req 9.5, 9.6, 9.7, 9.8, 10.7, 10.8).
 *
 * Four mutually exclusive states, in the order they can occur: a `Spinner` while the list is in
 * flight, an `ErrorNotice` with a retry when it failed (Req 10.8), an `EmptyState` pointing at
 * `/diagnosis` when the store is genuinely empty (Req 9.8), and the `HistoryGrid` otherwise. Empty
 * is not folded into the error branch — a first-time user has done nothing wrong, and the panel they
 * see should offer the route out rather than a retry.
 *
 * **The delete is confirmed before anything is called.** Pressing Delete only opens `ConfirmDialog`.
 * `api.deleteScan` runs on confirm and nowhere else, so Cancel and Escape leave the store and the
 * list exactly as they were (Req 9.5). On success the entry is dropped from local state — no reload
 * (Req 9.6).
 *
 * **Focus does not get lost.** `ConfirmDialog` restores focus to whatever was focused when it
 * opened, so `requestDelete` focuses the Delete button that was pressed before opening: a click does
 * not focus a button in every browser, and leaving it to chance is how Cancel drops the user at the
 * top of the page. After a *successful* delete that button no longer exists, and the dialog skips a
 * detached node by design, so focus moves to the list container instead — done from an effect, which
 * runs after the dialog's own cleanup rather than racing it.
 *
 * **One announcement channel.** The single `LiveRegion` speaks the outcome of a delete, success or
 * failure (Req 12.6). A failed delete additionally renders an `ErrorNotice` above the grid, carrying
 * the backend's own message (Req 10.7) — a 404 there means the entry was already gone (Req 9.9). It
 * has no retry button: the row's own Delete control is still on screen, which is the same request.
 *
 * **The detail view follows the same pattern, and only one dialog is open at a time.** `requestView`
 * focuses the View button before opening `ScanDetailDialog`, exactly as `requestDelete` does, so
 * closing puts focus back on the row. Each request also clears the other's state, because two
 * `aria-modal` dialogs mounted together leave assistive technology with two competing claims about
 * what the rest of the page is — and the second one's focus restore would fight the first's. The two
 * flows share nothing else: the detail view never touches the list, and the delete path is untouched
 * by it.
 */

/**
 * Primary call-to-action styling for a `Link`, mirroring `Button`'s `primary` variant: navigation
 * belongs to an anchor, and an `<a>` may not contain a `<button>`. Same treatment as the Home hero.
 */
const CTA_LINK_CLASSES = [
  "focus-ring btn-primary-gradient inline-flex min-h-12 items-center justify-center gap-2",
  "rounded-2xl px-7 py-3",
  "font-heading text-body-lg font-semibold text-white",
].join(" ");

export function HistoryPage(): JSX.Element {
  const {
    items,
    total,
    loading,
    error,
    isEmpty,
    deletingId,
    deletingAll,
    reload,
    deleteItem,
    clearAllHistory,
  } = useHistory();

  /** The scan the confirm dialog is asking about; `null` when it is closed. */
  const [pending, setPending] = useState<HistoryItem | null>(null);
  /** Whether the delete-all confirm dialog is open. */
  const [pendingDeleteAll, setPendingDeleteAll] = useState<boolean>(false);
  /** The scan open in the detail view; `null` when it is closed. */
  const [viewing, setViewing] = useState<HistoryItem | null>(null);
  /** Message from a delete that failed. Separate from `error`, which is about the list itself. */
  const [deleteError, setDeleteError] = useState<string | null>(null);
  /** Text for the live region; changing it is what announces (Req 12.6). */
  const [notice, setNotice] = useState<string>("");
  /** Bumped after a successful delete to move focus off the row that no longer exists. */
  const [refocusToken, setRefocusToken] = useState<number>(0);

  const mounted = useRef(true);
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    // `0` is the initial value, so nothing is focused on first render — only after a delete.
    if (refocusToken === 0) return;
    listRef.current?.focus();
  }, [refocusToken]);

  const requestView = useCallback((item: HistoryItem, trigger: HTMLButtonElement): void => {
    // A click does not focus a button in every browser, so the trigger is focused explicitly before
    // the dialog mounts — that is the element the dialog reads and restores on close.
    trigger.focus();
    // Never both dialogs at once.
    setPending(null);
    setViewing(item);
  }, []);

  const closeView = useCallback((): void => {
    setViewing(null);
  }, []);

  const requestDelete = useCallback((item: HistoryItem, trigger: HTMLButtonElement): void => {
    trigger.focus();
    setViewing(null);
    setDeleteError(null);
    setPending(item);
  }, []);

  const cancelDelete = useCallback((): void => {
    // Escape reaches `onCancel` even while the request is in flight, and closing the dialog then
    // would say "cancelled" about a delete that is already going through. The dialog disables its
    // own two buttons while `busy`; this covers the key.
    if (deletingId !== null) return;
    setPending(null);
  }, [deletingId]);

  const confirmDelete = useCallback((): void => {
    const item = pending;
    if (item === null) return;

    void (async () => {
      const outcome = await deleteItem(item.id);
      if (!mounted.current) return;

      setPending(null);

      if (outcome.ok) {
        setDeleteError(null);
        setNotice(
          `Deleted the scan from ${formatTimestamp(item.created_at)} diagnosed as ${item.display_name}.`,
        );
        setRefocusToken((token) => token + 1);
        return;
      }

      // The backend's wording, both on screen and in the announcement.
      setDeleteError(outcome.message);
      setNotice(outcome.message);
    })();
  }, [deleteItem, pending]);

  const cancelDeleteAll = useCallback((): void => {
    if (deletingAll) return;
    setPendingDeleteAll(false);
  }, [deletingAll]);

  const confirmDeleteAll = useCallback((): void => {
    void (async () => {
      const outcome = await clearAllHistory();
      if (!mounted.current) return;

      setPendingDeleteAll(false);

      if (outcome.ok) {
        setDeleteError(null);
        setNotice("All scan history and photos have been deleted.");
        setRefocusToken((token) => token + 1);
        return;
      }

      setDeleteError(outcome.message);
      setNotice(outcome.message);
    })();
  }, [clearAllHistory]);

  const busy = pending !== null && deletingId === pending.id;
  const showCount = !loading && error === null && !isEmpty;

  return (
    <div className="animate-fade-in">
      {/* Light gradient header band */}
      <div className="border-b border-stone-100 bg-gradient-to-b from-stone-50 to-white">
        <section
          aria-labelledby="history-heading"
          className="mx-auto w-full max-w-5xl animate-fade-in-up px-4 pt-12 pb-10 sm:px-6 sm:pt-20 sm:pb-14"
        >
          <SectionHeading
            id="history-heading"
            level={1}
            description="Every scan this backend has saved, newest first."
          >
            Scan history
          </SectionHeading>

          {showCount ? (
            <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
              <div className="inline-flex items-center gap-1.5 rounded-full border border-stone-200 bg-white px-3 py-1 shadow-sm">
                <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-leaf-500" />
                <p className="numeric text-small font-semibold text-ink-700" data-testid="history-count">
                  {items.length === total
                    ? `${String(total)} saved ${total === 1 ? "scan" : "scans"}`
                    : `Showing the ${String(items.length)} most recent of ${String(total)} scans`}
                </p>
              </div>

              <Button
                variant="destructive"
                size="sm"
                onClick={() => {
                  setPending(null);
                  setViewing(null);
                  setPendingDeleteAll(true);
                }}
                disabled={deletingAll || items.length === 0}
                aria-label="Delete all scan history"
                className="gap-1.5 shadow-sm"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="15"
                  height="15"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M3 6h18" />
                  <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
                  <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
                  <line x1="10" y1="11" x2="10" y2="17" />
                  <line x1="14" y1="11" x2="14" y2="17" />
                </svg>
                Delete all history
              </Button>
            </div>
          ) : null}
        </section>
      </div>

      {/* List area */}
      <div className="mx-auto w-full max-w-5xl px-4 py-10 sm:px-6 sm:py-14">
        {/* Present from first render with an empty message: a live region that mounts together with
            its text is frequently not announced at all (Req 12.6). */}
        <LiveRegion message={notice} />

        {/*
         * Focus target for the moment after a delete, when the pressed button is gone. `tabIndex={-1}`
         * keeps it out of the Tab order — it can be focused, but never tabbed into.
         */}
        <div ref={listRef} tabIndex={-1} className="focus-ring">
          {loading ? (
            <Card className="flex items-center justify-center py-16">
              <Spinner size="lg" label="Loading your scan history…" showLabel />
            </Card>
          ) : error !== null ? (
            <ErrorNotice
              title="Scan history unavailable"
              message={error}
              onRetry={reload}
              retryLabel="Retry"
            >
              Nothing has been deleted. Start the backend, then retry to load your saved scans.
            </ErrorNotice>
          ) : isEmpty ? (
            <EmptyState
              title="No scans yet"
              description="Diagnoses you run are saved here, with the photo, the confidence figure, and the treatment guidance that came with it."
              action={
                <Link to="/diagnosis" className={CTA_LINK_CLASSES}>
                  Start a diagnosis
                </Link>
              }
            />
          ) : (
            <>
              {deleteError !== null ? (
                <ErrorNotice
                  className="mb-6"
                  title="That scan was not deleted"
                  message={deleteError}
                />
              ) : null}
              <HistoryGrid
                items={items}
                onView={requestView}
                onDelete={requestDelete}
                deletingId={deletingId}
              />
            </>
          )}
        </div>
      </div>

      {/* Fetches on open, keyed on the scan; nothing is requested while `viewing` is `null`. */}
      <ScanDetailDialog open={viewing !== null} item={viewing} onClose={closeView} />

      <ConfirmDialog
        open={pending !== null}
        title="Delete this scan?"
        description={
          pending === null
            ? undefined
            : `The scan from ${formatTimestamp(pending.created_at)} diagnosed as ${pending.display_name} will be removed, along with its stored photo. This cannot be undone.`
        }
        confirmLabel="Delete scan"
        busy={busy}
        onConfirm={confirmDelete}
        onCancel={cancelDelete}
      />

      <ConfirmDialog
        open={pendingDeleteAll}
        title="Delete all scan history?"
        description={`All ${String(total)} saved diagnoses and their stored photos will be permanently deleted. This cannot be undone.`}
        confirmLabel="Delete all history"
        busy={deletingAll}
        onConfirm={confirmDeleteAll}
        onCancel={cancelDeleteAll}
      />
    </div>
  );
}

export default HistoryPage;
