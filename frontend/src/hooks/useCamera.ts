import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Own the device camera stream for `CameraCapture` (Req 3.4, 3.9).
 *
 * A camera is not a value you read, it is a resource you hold, and the failure that matters is not
 * a missing preview — it is a stream left running after the user moved on, with the hardware
 * indicator still lit. So the lifetime lives here rather than in the component: every path that
 * ends a session (unmount, capture, cancel, and starting a second time) goes through one
 * `stopTracks` call, and the only way to obtain a stream is `start`.
 *
 * The constraints ask for the rear camera and a wide frame as *ideals*, never as requirements. A
 * hard `facingMode: "environment"` fails outright on a laptop, which is a real use case for this
 * app; `ideal` degrades to whatever camera exists (Req 3.4).
 *
 * Every failure maps to one of the four messages in the design's camera table (Req 3.9), and all
 * four name a way forward — drop a photo, choose a file — because the drop zone and the file picker
 * stay operable no matter what the camera does. The mapping is by `DOMException.name`, not by
 * message text, since the browser's own wording is neither stable nor user-facing.
 *
 * Two guards keep state settled: `mounted` stops a resolution from writing to an unmounted
 * component, and `runId` supersedes an in-flight `getUserMedia` when the user cancels or restarts —
 * a stream that arrives after being superseded is stopped immediately rather than kept alive
 * unreferenced.
 */

/**
 * `ideal` throughout: a rear camera and a 1920 px frame where the device has them, whatever exists
 * otherwise. `exact` would turn a laptop webcam into an `OverconstrainedError`.
 */
export const CAMERA_CONSTRAINTS: MediaStreamConstraints = {
  video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 } },
};

// --- messages (design's camera failure table, Req 3.9) ------------------------------

/** API absent: an old browser, or a non-secure context, where `getUserMedia` does not exist. */
export const CAMERA_UNAVAILABLE_MESSAGE =
  "Camera access is unavailable in this browser. You can still drop a photo or choose a file.";

/** Permission denied — `NotAllowedError`, or `SecurityError` where the policy blocks the request. */
export const CAMERA_BLOCKED_MESSAGE =
  "Camera access was blocked. Allow camera permission in your browser settings, or drop a photo instead.";

/** No device — `NotFoundError`, or `OverconstrainedError` when nothing satisfies the constraints. */
export const CAMERA_NOT_FOUND_MESSAGE =
  "No camera was found on this device. You can still drop a photo or choose a file.";

/** Held by another application — `NotReadableError`. Retrying can succeed, so the panel offers it. */
export const CAMERA_IN_USE_MESSAGE =
  "The camera is in use by another app. Close it and retry, or choose a file instead.";

/**
 * `DOMException.name` → message. Legacy WebKit and pre-spec Chrome names sit alongside the current
 * ones: the mapping is a lookup, so covering them costs a line each and avoids a stream of
 * unrecognised failures falling through to the generic text.
 */
const MESSAGE_BY_ERROR_NAME: Readonly<Record<string, string>> = {
  NotAllowedError: CAMERA_BLOCKED_MESSAGE,
  SecurityError: CAMERA_BLOCKED_MESSAGE,
  PermissionDeniedError: CAMERA_BLOCKED_MESSAGE,
  NotFoundError: CAMERA_NOT_FOUND_MESSAGE,
  OverconstrainedError: CAMERA_NOT_FOUND_MESSAGE,
  DevicesNotFoundError: CAMERA_NOT_FOUND_MESSAGE,
  NotReadableError: CAMERA_IN_USE_MESSAGE,
  TrackStartError: CAMERA_IN_USE_MESSAGE,
};

/** `name` off an unknown throw, without assuming it is a `DOMException` or even an `Error`. */
function errorName(error: unknown): string {
  if (typeof error === "object" && error !== null && "name" in error) {
    const { name } = error as { readonly name?: unknown };
    if (typeof name === "string") return name;
  }
  return "";
}

/**
 * Map a `getUserMedia` rejection to one of the four user-facing messages.
 *
 * An unrecognised failure reads as {@link CAMERA_UNAVAILABLE_MESSAGE} rather than inventing a fifth
 * string: whatever went wrong, the camera is not available and the other two intake paths are.
 */
export function cameraErrorMessage(error: unknown): string {
  return MESSAGE_BY_ERROR_NAME[errorName(error)] ?? CAMERA_UNAVAILABLE_MESSAGE;
}

// --- hook ---------------------------------------------------------------------------

/**
 * `idle` before and after a session, `starting` while the permission prompt is up, `ready` with a
 * live stream, `error` with a message from the table.
 */
export type CameraStatus = "idle" | "starting" | "ready" | "error";

/** `true` when `navigator.mediaDevices.getUserMedia` exists. Synchronous, so it can gate the UI. */
export function isCameraSupported(): boolean {
  return (
    typeof navigator !== "undefined" && typeof navigator.mediaDevices?.getUserMedia === "function"
  );
}

export interface UseCameraResult {
  /** Which of the four states the camera is in. */
  status: CameraStatus;
  /** The live stream while `ready`, `null` otherwise. Assign it to a `<video srcObject>`. */
  stream: MediaStream | null;
  /** A message from the design's table while `error`, `null` otherwise. Render as-is. */
  error: string | null;
  /**
   * Whether this browser exposes `getUserMedia` at all. `false` means the camera control should
   * never be offered — show the message instead, and leave the other intake paths alone.
   */
  supported: boolean;
  /** Request the camera. Stops any stream already held first. Stable across renders. */
  start: () => void;
  /**
   * Stop every track and return to `idle`. Called on cancel and on capture; also runs on unmount,
   * so the hardware indicator cannot outlive the component.
   */
  stop: () => void;
}

/**
 * @returns the camera's state and its two lifecycle controls
 */
export function useCamera(): UseCameraResult {
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [status, setStatus] = useState<CameraStatus>("idle");
  const [error, setError] = useState<string | null>(null);

  const streamRef = useRef<MediaStream | null>(null);
  const mounted = useRef(true);
  const runId = useRef(0);

  /**
   * The single release path. Every track is stopped, not just the video one: an audio track we
   * never asked for but were handed would keep the indicator lit on its own.
   */
  const stopTracks = useCallback((): void => {
    const current = streamRef.current;
    streamRef.current = null;
    if (!current) return;
    current.getTracks().forEach((track) => {
      track.stop();
    });
  }, []);

  const stop = useCallback((): void => {
    // Bump first: a `getUserMedia` still in flight is now stale and its stream will be discarded.
    runId.current += 1;
    stopTracks();
    if (!mounted.current) return;
    setStream(null);
    setStatus("idle");
    setError(null);
  }, [stopTracks]);

  const start = useCallback((): void => {
    if (!isCameraSupported()) {
      // Detectable without a request, so there is no reason to show a spinner first.
      setStream(null);
      setStatus("error");
      setError(CAMERA_UNAVAILABLE_MESSAGE);
      return;
    }

    const run = ++runId.current;
    /** Ignore a resolution from an unmounted component or a superseded attempt. */
    const stale = (): boolean => !mounted.current || run !== runId.current;

    // Release the previous session before asking for another: two live streams means two indicators.
    stopTracks();
    setStream(null);
    setStatus("starting");
    setError(null);

    void (async (): Promise<void> => {
      try {
        const next = await navigator.mediaDevices.getUserMedia(CAMERA_CONSTRAINTS);
        if (stale()) {
          // The user cancelled while the prompt was up. The grant still arrived, so it still has to
          // be released — this is the leak the requirement is really about.
          next.getTracks().forEach((track) => {
            track.stop();
          });
          return;
        }
        streamRef.current = next;
        setStream(next);
        setStatus("ready");
      } catch (e) {
        if (stale()) return;
        setStream(null);
        setStatus("error");
        setError(cameraErrorMessage(e));
      }
    })();
  }, [stopTracks]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      // Supersede any in-flight request, then release whatever is held (Req 3.9's cleanup clause).
      runId.current += 1;
      stopTracks();
    };
  }, [stopTracks]);

  return { status, stream, error, supported: isCameraSupported(), start, stop };
}

export default useCamera;
