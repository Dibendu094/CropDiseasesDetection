import { useCallback, useEffect, useRef, useState } from "react";

import { api } from "../api/client";
import { GENERIC_ERROR_MESSAGE, isApiClientError } from "../api/errors";
import type { HistoryItem } from "../api/types";

/**
 * Load `GET /api/history` once on mount and own the list from then on (Req 9.2, 9.6, 9.8, 10.8).
 *
 * The History page has four renderable outcomes — pending, failed, empty, loaded — and the third
 * is not a special case of the second: an empty store is a normal state with its own copy and its
 * own route out (Req 9.8), while an unreachable backend is a failure with a retry (Req 10.8). So
 * `error` and emptiness are reported separately, and `isEmpty` is only ever true once a request has
 * actually come back clean.
 *
 * The list arrives newest-first from the backend (Req 9.2) and is stored in that order untouched.
 * Sorting again here would put the client's clock and the server's `created_at` in competition.
 *
 * **Delete edits the list in place.** `deleteItem` awaits the `204`, then filters the removed id out
 * of local state and decrements `total`; it does not re-fetch (Req 9.6). A reload would cost a round
 * trip, blank the grid behind a spinner, and — with a paged window — pull a previously unseen entry
 * up into the gap, so the one row the user asked to remove is not the only thing that changes on
 * screen.
 *
 * A failed delete is returned to the caller rather than written to `error`. The two failures need
 * different treatment: a failed *list* replaces the page, whereas a failed delete leaves a perfectly
 * good list on screen and only needs a message beside it (Req 10.7, 10.8). Either way the string is
 * `ApiClientError.message`, the backend's own wording.
 *
 * Two guards keep state settled, the same pair `useMetadata` uses: `mounted` stops a resolution from
 * writing to an unmounted component, and `runId` stops a slow first attempt from landing on top of
 * the reload that replaced it.
 */

/** Default paging window, matching `api.history`'s own default and the backend's (Req 9.2). */
export const DEFAULT_HISTORY_LIMIT = 50;

/** The result of one delete attempt: success, or the message to show the user. */
export type DeleteOutcome = { readonly ok: true } | { readonly ok: false; readonly message: string };

/** What the History page needs to render every state of the list and run a delete. */
export interface UseHistoryResult {
  /** The scans, newest first, as the backend ordered them. `[]` until the first load lands. */
  items: readonly HistoryItem[];
  /** Rows in the store, per the last response, kept in step by `deleteItem`. */
  total: number;
  /** `true` while a list request is in flight, including a `reload`. */
  loading: boolean;
  /** `ApiClientError.message` — already user-facing (Req 10.7) — or `null`. */
  error: string | null;
  /** `true` only after a successful load that returned no rows (Req 9.8). */
  isEmpty: boolean;
  /** Id of the scan currently being deleted, for a per-row busy state; `null` when idle. */
  deletingId: string | null;
  /** `true` while a delete-all request is in flight. */
  deletingAll: boolean;
  /** Retries the list fetch; stable across renders, so it is safe in a dependency list. */
  reload: () => void;
  /** Deletes one scan and, on success, removes it from local state without a reload (Req 9.6). */
  deleteItem: (id: string) => Promise<DeleteOutcome>;
  /** Deletes all scans and resets local state to empty. */
  clearAllHistory: () => Promise<DeleteOutcome>;
}

/**
 * @param limit - paging window passed to `GET /api/history`
 * @returns the list state, a retry callback, and the delete action
 */
export function useHistory(limit: number = DEFAULT_HISTORY_LIMIT): UseHistoryResult {
  const [items, setItems] = useState<readonly HistoryItem[]>([]);
  const [total, setTotal] = useState<number>(0);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<boolean>(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deletingAll, setDeletingAll] = useState<boolean>(false);

  const mounted = useRef(true);
  const runId = useRef(0);

  const load = useCallback(async (): Promise<void> => {
    const run = ++runId.current;
    /** Ignore a resolution from an unmounted component or a superseded attempt. */
    const stale = (): boolean => !mounted.current || run !== runId.current;

    setLoading(true);
    setError(null);

    try {
      const result = await api.history(limit);
      if (stale()) return;
      setItems(result.items);
      setTotal(result.total);
      setLoaded(true);
    } catch (e) {
      if (stale()) return;
      // Every `api.*` call fails with an `ApiClientError`; the fallback covers a throw from
      // somewhere else so the panel never renders an empty message.
      setError(isApiClientError(e) ? e.message : GENERIC_ERROR_MESSAGE);
      setLoaded(false);
    } finally {
      if (!stale()) setLoading(false);
    }
  }, [limit]);

  const reload = useCallback((): void => {
    void load();
  }, [load]);

  const deleteItem = useCallback(async (id: string): Promise<DeleteOutcome> => {
    setDeletingId(id);

    try {
      await api.deleteScan(id);
      if (mounted.current) {
        // Filter rather than splice: a new array is what tells React the grid changed, and
        // matching on id keeps the removal correct whatever the list has done since.
        setItems((current) => current.filter((item) => item.id !== id));
        setTotal((current) => Math.max(0, current - 1));
      }
      return { ok: true };
    } catch (e) {
      // Returned, not stored: the list on screen is still valid, so the caller decides where this
      // message goes. A 404 here means the entry was already gone (Req 9.9).
      return { ok: false, message: isApiClientError(e) ? e.message : GENERIC_ERROR_MESSAGE };
    } finally {
      if (mounted.current) setDeletingId(null);
    }
  }, []);

  const clearAllHistory = useCallback(async (): Promise<DeleteOutcome> => {
    setDeletingAll(true);

    try {
      await api.deleteAllHistory();
      if (mounted.current) {
        setItems([]);
        setTotal(0);
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, message: isApiClientError(e) ? e.message : GENERIC_ERROR_MESSAGE };
    } finally {
      if (mounted.current) setDeletingAll(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
    };
  }, [load]);

  return {
    items,
    total,
    loading,
    error,
    isEmpty: loaded && items.length === 0,
    deletingId,
    deletingAll,
    reload,
    deleteItem,
    clearAllHistory,
  };
}

export default useHistory;
