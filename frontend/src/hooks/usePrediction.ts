import { useCallback, useEffect, useRef, useState } from "react";

import { api } from "../api/client";
import { GENERIC_ERROR_MESSAGE, isApiClientError } from "../api/errors";
import type { PredictResponse } from "../api/types";

/**
 * Submit one image to `POST /api/predict` and own the request's state (Req 3.7, 6.7, 10.7, 10.8).
 *
 * The state is a **discriminated union rather than four loose fields**, because the four impossible
 * combinations are the ones that produce a wrong screen: a `success` with no result, a `pending`
 * still showing the previous diagnosis, an `error` with an empty message. Shaped this way, the
 * union drops straight onto `ResultBox`'s own union and the page cannot assemble a state the panel
 * has no branch for.
 *
 * **`network` is the only kind that means `unreachable`.** `ApiClientError.kind` distinguishes a
 * request that never left the browser from one the backend answered badly, and that distinction is
 * the whole of Req 10.8 — the panel's heading changes, and the message is the client's
 * `UNREACHABLE_MESSAGE` rather than anything the server said. Everything else, including `timeout`
 * (the 60 s budget of Req 6.7) and `malformed`, is an `error`: the backend was there, so its own
 * wording wins (Req 10.7).
 *
 * **`retry` re-submits the same `File` *and* the same crop.** Both are held in refs rather than read
 * back out of state, so a retry after a failure does not depend on the upload panel still holding a
 * selection, and it cannot silently send a different photo — or a different crop restriction — than
 * the one that failed. Repeating the photo but dropping the crop would quietly widen the model back
 * to every class, and the second answer would differ from the first for a reason the user never
 * asked for. With nothing submitted yet, `retry` is a no-op — there is no request to repeat.
 *
 * Two guards keep the state settled, the same pair `useMetadata` and `useHistory` use: `mounted`
 * stops a resolution from writing to an unmounted component, and `runId` stops a slow first attempt
 * from landing on top of the retry that replaced it. `reset` bumps `runId` as well, so a request
 * still in flight when the user clears the photo can no longer put a result on screen.
 */

/** The five states of a prediction, exactly one of which holds at a time. */
export type PredictionState =
  | { readonly status: "idle" }
  | { readonly status: "pending" }
  | { readonly status: "success"; readonly result: PredictResponse }
  /**
   * `unreachable` when `ApiClientError.kind === "network"`, `error` for every other kind. Both carry
   * a non-empty, already user-facing `message` (Req 10.7, 10.8).
   */
  | { readonly status: "error" | "unreachable"; readonly message: string };

/** Which of the five states is current; the discriminant of {@link PredictionState}. */
export type PredictionStatus = PredictionState["status"];

/** The initial state: nothing submitted, nothing to show. */
export const IDLE_PREDICTION: PredictionState = { status: "idle" };

/** What the Diagnosis page needs to render every state of a prediction and drive a retry. */
export interface UsePredictionResult {
  /**
   * The current state. `state.result` exists only on `success`, and `state.message` only on the two
   * failure states — which is where the page reads the message from.
   */
  state: PredictionState;
  /**
   * `true` while a request is in flight, `state.status === "pending"` by another name. Kept as a
   * field because it is what the upload panel's `busy` prop wants (Req 3.8).
   */
  pending: boolean;
  /**
   * The `File` behind the current state, or `null` before the first submit and after a `reset`.
   *
   * Exposed for the downloadable report, which embeds the photo as a `data:` URL: the response only
   * carries an `image_url` pointing at the server, and a saved report has to stay readable offline.
   * It is the same ref `retry` re-sends, so the photo in the report is by construction the photo that
   * produced the result — the page cannot pair a diagnosis with a different image.
   *
   * Safe to read despite being a ref: it is assigned before the `pending` state transition, so every
   * render that can show a result has already seen it.
   */
  submittedFile: File | null;
  /**
   * Sends a file and moves through `pending` to `success`, `error`, or `unreachable`.
   *
   * `crop` is the optional crop restriction. Omitted or empty means "detect automatically"; the
   * client only appends the form field for a non-empty value.
   */
  submit: (file: File, crop?: string) => void;
  /** Re-sends the file *and* crop from the last `submit`. A no-op until one has happened. */
  retry: () => void;
  /** Returns to `idle` and abandons any in-flight request's result. */
  reset: () => void;
}

/**
 * @returns the prediction state and the three actions that drive it
 */
export function usePrediction(): UsePredictionResult {
  const [state, setState] = useState<PredictionState>(IDLE_PREDICTION);

  const mounted = useRef(true);
  const runId = useRef(0);
  /** The last submitted file, so `retry` repeats the same request rather than a similar one. */
  const lastFile = useRef<File | null>(null);
  /** The crop that went with it. Kept beside the file so the pair cannot come apart on a retry. */
  const lastCrop = useRef<string | undefined>(undefined);

  const send = useCallback(async (file: File, crop?: string): Promise<void> => {
    const run = ++runId.current;
    /** Ignore a resolution from an unmounted component or a superseded attempt. */
    const stale = (): boolean => !mounted.current || run !== runId.current;

    lastFile.current = file;
    lastCrop.current = crop;
    // The previous result goes with the previous photo. Leaving it on screen under a spinner is how
    // a user ends up reading last submission's treatment guidance as if it were this one's.
    setState({ status: "pending" });

    try {
      const result = await api.predict(file, crop);
      if (stale()) return;
      setState({ status: "success", result });
    } catch (e) {
      if (stale()) return;
      // Every `api.*` call fails with an `ApiClientError`; the fallback covers a throw from
      // somewhere else so the panel never renders an empty message.
      const unreachable = isApiClientError(e) && e.kind === "network";
      setState({
        status: unreachable ? "unreachable" : "error",
        message: isApiClientError(e) ? e.message : GENERIC_ERROR_MESSAGE,
      });
    }
  }, []);

  const submit = useCallback(
    (file: File, crop?: string): void => {
      void send(file, crop);
    },
    [send],
  );

  const retry = useCallback((): void => {
    const file = lastFile.current;
    // Nothing submitted yet: there is no request to repeat, and inventing one would send nothing.
    if (file === null) return;
    // The crop from the same submission, not whatever the picker shows now: a retry repeats a
    // request, it does not compose a new one.
    void send(file, lastCrop.current);
  }, [send]);

  const reset = useCallback((): void => {
    // Bump first: a response still in flight is now stale, so it cannot revive a panel the user has
    // already cleared.
    runId.current += 1;
    lastFile.current = null;
    lastCrop.current = undefined;
    setState(IDLE_PREDICTION);
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  return {
    state,
    pending: state.status === "pending",
    submittedFile: lastFile.current,
    submit,
    retry,
    reset,
  };
}

export default usePrediction;
