import { useCallback, useEffect, useRef, useState } from "react";

import { api } from "../api/client";
import { GENERIC_ERROR_MESSAGE, isApiClientError } from "../api/errors";
import type { ClassMetadata } from "../api/types";

/**
 * Load `GET /api/meta/classes` once on mount and expose it with its loading and error state.
 *
 * The Home page states the model's real coverage — crop count, class count, threshold, upload
 * limit — rather than numbers typed into the markup, so those figures cannot drift from the
 * checkpoints the backend actually loaded (Req 2.2). That makes the fetch a page-level concern
 * with three renderable outcomes, which is what this hook packages: a spinner while `loading`,
 * an `ErrorNotice` plus `reload` when `error` is set, the real counts when `data` arrives.
 *
 * The values pass through untouched. No rounding, no `?? 0`, no percentage conversion: a
 * default would render as a plausible-looking wrong number, and the caller cannot tell it from
 * a real one. If a count is missing the contract is broken, and the type says it is not
 * missing.
 *
 * Two guards keep the state settled after the component is gone or the user retried:
 * `mounted` stops a resolution from writing to an unmounted component, and `runId` stops a
 * slow first attempt from landing on top of the reload that replaced it.
 */

/** What the Home page needs to render every state of the metadata fetch. */
export interface UseMetadataResult {
  /** The response, or `null` until the first successful load. */
  data: ClassMetadata | null;
  /** `ApiClientError.message` — already user-facing (Req 10.7) — or `null`. */
  error: string | null;
  /** `true` while a request is in flight, including a `reload`. */
  loading: boolean;
  /** Retries the fetch; stable across renders, so it is safe in a dependency list. */
  reload: () => void;
}

/**
 * @returns the metadata fetch state and a retry callback
 */
export function useMetadata(): UseMetadataResult {
  const [data, setData] = useState<ClassMetadata | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(true);

  const mounted = useRef(true);
  const runId = useRef(0);

  const load = useCallback(async (): Promise<void> => {
    const run = ++runId.current;
    /** Ignore a resolution from an unmounted component or a superseded attempt. */
    const stale = (): boolean => !mounted.current || run !== runId.current;

    setLoading(true);
    setError(null);

    try {
      const result = await api.metadata();
      if (stale()) return;
      setData(result);
    } catch (e) {
      if (stale()) return;
      // Every `api.*` call fails with an `ApiClientError`; the fallback covers a throw from
      // somewhere else so the panel never renders an empty message.
      setError(isApiClientError(e) ? e.message : GENERIC_ERROR_MESSAGE);
    } finally {
      if (!stale()) setLoading(false);
    }
  }, []);

  const reload = useCallback((): void => {
    void load();
  }, [load]);

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
    };
  }, [load]);

  return { data, error, loading, reload };
}

export default useMetadata;
