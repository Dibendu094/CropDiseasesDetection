import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "../ui/Button";
import { ErrorNotice } from "../ui/ErrorNotice";
import { CAMERA_UNAVAILABLE_MESSAGE, useCamera } from "../../hooks/useCamera";

/**
 * The third intake path: a live preview and a still frame taken from it (Req 3.4).
 *
 * The point of capturing to a canvas rather than using `<input capture>` is that the result has to
 * be indistinguishable from the other two paths. `canvas.toBlob(cb, "image/jpeg", 0.92)` produces a
 * blob, the blob is wrapped in a real `File` with a name and a MIME type, and that `File` is handed
 * to the same `onCapture` → `validateImage` → submit pipeline a dropped file goes through. Nothing
 * downstream can tell where the photo came from, which is what Property 26 asserts.
 *
 * `autoPlay playsInline muted` is three separate requirements on iOS Safari, not styling: without
 * `playsInline` the preview takes over the screen in a native player, and without `muted` autoplay
 * is refused outright. `play()` is called as well, since a `srcObject` assigned after mount does not
 * always trigger `autoPlay`.
 *
 * When the camera is unavailable this component renders the mapped message and nothing else
 * (Req 3.9). It never disables or hides anything outside itself — the drop zone and the file picker
 * are siblings in `UploadBox` and stay fully operable, which is the second half of that
 * requirement. Where `getUserMedia` does not exist at all, the message replaces the button rather
 * than sitting behind it: offering a control that cannot work is worse than explaining why.
 *
 * `useCamera` owns the stream, so cancel and capture both end with every track stopped and the
 * hardware indicator off (Req 3.9).
 */

/** JPEG at 0.92: visually lossless for a leaf photo, and a fraction of a PNG's bytes. */
const CAPTURE_MIME = "image/jpeg";
const CAPTURE_QUALITY = 0.92;

/**
 * Not in the design's failure table — that table is about camera *access*. This covers a frame that
 * could not be encoded, which is a retry-in-place failure, so the wording points back at the
 * button.
 */
export const CAPTURE_FAILED_MESSAGE =
  "The photo could not be captured. Try again, or choose a file instead.";

/** `crop-photo-2026-08-30T15-04-05-123Z.jpg` — sortable, and legal on every filesystem. */
function captureFileName(): string {
  return `crop-photo-${new Date().toISOString().replace(/[:.]/g, "-")}.jpg`;
}

export interface CameraCaptureProps {
  /** Called with the captured still. Enters the same pipeline as a dropped or picked file. */
  onCapture: (file: File) => void;
  /** Ignore activation, e.g. while a prediction is in flight. */
  disabled?: boolean;
  /** Label of the control that opens the camera. Defaults to "Take a picture". */
  openLabel?: string;
  /** Extra classes for the wrapper. */
  className?: string;
}

export function CameraCapture({
  onCapture,
  disabled = false,
  openLabel = "Take a picture",
  className,
}: CameraCaptureProps): JSX.Element {
  const { status, stream, error, supported, start, stop } = useCamera();
  const [captureError, setCaptureError] = useState<string | null>(null);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const openRef = useRef<HTMLButtonElement | null>(null);
  const captureRef = useRef<HTMLButtonElement | null>(null);
  /** Set when the user leaves the preview, so focus returns to the control they came from. */
  const restoreFocus = useRef(false);

  // Attach the stream to the element. Assigning `srcObject` is the documented way to preview a
  // MediaStream; `src` with an object URL was removed from the spec.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    video.srcObject = stream;
    if (stream === null) return;

    try {
      const played: unknown = video.play();
      // A rejected play promise is not actionable here — the preview simply stays on its first
      // frame — and an unhandled rejection would surface as a console error on every mount.
      if (played instanceof Promise) void played.catch(() => undefined);
    } catch {
      // jsdom has no media stack, and some browsers throw synchronously instead of rejecting.
    }

    return () => {
      video.srcObject = null;
    };
  }, [stream]);

  // Keyboard continuity (Req 12.3): the Capture button takes focus when the preview appears, and
  // focus goes back to the opening control when it closes. Guarded by `restoreFocus` so a first
  // render never steals focus from elsewhere on the page.
  useEffect(() => {
    if (status === "ready") {
      captureRef.current?.focus();
      restoreFocus.current = true;
      return;
    }
    if (restoreFocus.current) {
      restoreFocus.current = false;
      openRef.current?.focus();
    }
  }, [status]);

  const handleOpen = useCallback((): void => {
    setCaptureError(null);
    start();
  }, [start]);

  const handleCancel = useCallback((): void => {
    setCaptureError(null);
    stop();
  }, [stop]);

  const handleCapture = useCallback((): void => {
    const video = videoRef.current;
    const width = video?.videoWidth ?? 0;
    const height = video?.videoHeight ?? 0;

    // No frame yet: the stream is live but the first frame has not decoded. Nothing to draw, and a
    // 0x0 canvas would encode a blank photo the user would then submit.
    if (!video || width === 0 || height === 0) {
      setCaptureError(CAPTURE_FAILED_MESSAGE);
      return;
    }

    const canvas = document.createElement("canvas");
    // The stream's own resolution, so the capture is not downscaled before the model sees it.
    canvas.width = width;
    canvas.height = height;

    const context = canvas.getContext("2d");
    if (!context || typeof canvas.toBlob !== "function") {
      setCaptureError(CAPTURE_FAILED_MESSAGE);
      return;
    }

    context.drawImage(video, 0, 0, width, height);
    setCaptureError(null);

    canvas.toBlob(
      (blob) => {
        if (!blob) {
          setCaptureError(CAPTURE_FAILED_MESSAGE);
          return;
        }
        // Release the camera as soon as the frame is encoded — the preview has served its purpose
        // and the indicator should not stay lit while the user reviews the photo (Req 3.9).
        stop();
        onCapture(
          new File([blob], captureFileName(), { type: CAPTURE_MIME, lastModified: Date.now() }),
        );
      },
      CAPTURE_MIME,
      CAPTURE_QUALITY,
    );
  }, [onCapture, stop]);

  // An absent API is known before anything is attempted, so the message is shown from first render
  // rather than waiting for a `start` the user has no control to trigger (Req 3.9).
  const message = captureError ?? error ?? (supported ? null : CAMERA_UNAVAILABLE_MESSAGE);

  return (
    <div
      data-testid="camera-capture"
      className={["flex flex-col items-center gap-3", className].filter(Boolean).join(" ")}
    >
      {status === "ready" ? (
        <>
          <video
            ref={videoRef}
            data-testid="camera-preview"
            autoPlay
            playsInline
            muted
            aria-label="Live camera preview"
            className="aspect-[4/3] w-full rounded-xl border border-stone-200 bg-ink-900 object-cover"
          />
          <div className="flex w-full flex-col-reverse gap-3 xs:flex-row xs:justify-center">
            <Button variant="secondary" onClick={handleCancel} disabled={disabled}>
              Cancel
            </Button>
            <Button buttonRef={captureRef} onClick={handleCapture} disabled={disabled}>
              Capture photo
            </Button>
          </div>
        </>
      ) : null}

      {/* Hidden while the preview is up: reopening is what Cancel is for. Absent entirely when the
          API is missing, since there is nothing for the button to do. */}
      {supported && status !== "ready" ? (
        <Button
          variant="secondary"
          buttonRef={openRef}
          onClick={handleOpen}
          disabled={disabled}
          loading={status === "starting"}
        >
          {openLabel}
        </Button>
      ) : null}

      {message === null ? null : (
        <ErrorNotice
          className="w-full"
          title="Camera unavailable"
          message={message}
          // Retry only where a second attempt could differ. With no `getUserMedia` it cannot, and a
          // dead button is worse than none.
          {...(supported ? { onRetry: handleOpen, retryLabel: "Try camera again" } : {})}
          retrying={status === "starting"}
        >
          Dropping a photo or choosing a file works as usual.
        </ErrorNotice>
      )}
    </div>
  );
}

export default CameraCapture;
