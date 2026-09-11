import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "../ui/Button";
import { formatMegabytes } from "../../lib/format";

/**
 * The selected photo, plus the control that clears it (Req 3.6).
 *
 * Two things here are not cosmetic.
 *
 * **The object URL is owned, not borrowed.** `URL.createObjectURL` pins the whole file in memory
 * until it is revoked, and this component is the only place a URL for the selection is created — so
 * it is also the only place one has to be released. Revoking happens on both paths that end a URL's
 * life: the Clear control revokes before telling the parent (Req 3.6), and the effect cleanup
 * revokes when the file is replaced or the component unmounts. Whichever runs first clears the ref,
 * so the other finds nothing to do.
 *
 * **The frame is reserved before the image loads.** A bare `<img>` has no height until its bytes
 * arrive, so the submit button below it would jump down the moment it did — the layout shift Req
 * 12.1 rules out at 360 px, where there is no slack to absorb it. A 4:3 aspect-ratio box holds the
 * space from first paint, and `object-contain` fits the photo inside it whatever its real ratio is,
 * rather than cropping a leaf out of frame.
 *
 * Alt text is `Selected crop photo, {filename}` (Req 12.5) — the filename is the only thing that
 * distinguishes one selection from the next, and it is what a user recognises when checking they
 * picked the right shot. A file with no name falls back to the prefix alone, so the attribute is
 * never empty.
 */

/** Prefix of the alt text, and the whole of it for a file with no usable name (Req 12.5). */
export const PREVIEW_ALT_PREFIX = "Selected crop photo";

/** `Selected crop photo, leaf-01.jpg`, or just the prefix when the file has no name. */
export function previewAltText(fileName: string): string {
  const name = typeof fileName === "string" ? fileName.trim() : "";
  return name === "" ? PREVIEW_ALT_PREFIX : `${PREVIEW_ALT_PREFIX}, ${name}`;
}

/** `null` where `createObjectURL` is unavailable, e.g. jsdom without a stub. */
function createObjectUrl(file: Blob): string | null {
  if (typeof URL === "undefined" || typeof URL.createObjectURL !== "function") return null;
  return URL.createObjectURL(file);
}

export interface ImagePreviewProps {
  /** The selected file, from any of the three intake paths. */
  file: File;
  /** Called after the object URL has been revoked. The parent drops the selection. */
  onClear: () => void;
  /** Clear label. Defaults to "Clear photo". */
  clearLabel?: string;
  /**
   * Request in flight: Clear stops responding, so a submitted photo cannot be pulled out from under
   * the request that is analysing it (Req 3.8).
   */
  busy?: boolean;
  /** Extra classes for the wrapper. */
  className?: string;
}

export function ImagePreview({
  file,
  onClear,
  clearLabel = "Clear photo",
  busy = false,
  className,
}: ImagePreviewProps): JSX.Element {
  const [url, setUrl] = useState<string | null>(null);
  const urlRef = useRef<string | null>(null);

  /** The single release path; clearing the ref makes a second call a no-op. */
  const revokeCurrent = useCallback((): void => {
    const current = urlRef.current;
    urlRef.current = null;
    if (current !== null && typeof URL.revokeObjectURL === "function") {
      URL.revokeObjectURL(current);
    }
  }, []);

  useEffect(() => {
    const next = createObjectUrl(file);
    urlRef.current = next;
    setUrl(next);
    // Runs before the effect for a replacement file, so at most one URL is ever live.
    return revokeCurrent;
  }, [file, revokeCurrent]);

  const handleClear = useCallback((): void => {
    // Revoke first: the parent's `onClear` unmounts this component, and releasing the blob should
    // not depend on the cleanup order that follows.
    revokeCurrent();
    setUrl(null);
    onClear();
  }, [onClear, revokeCurrent]);

  const alt = previewAltText(file.name);

  return (
    <div
      data-testid="image-preview"
      className={["flex flex-col gap-3", className].filter(Boolean).join(" ")}
    >
      {/* The reserved frame. `stone.100` fill so the box reads as a placeholder before the decode. */}
      <div className="relative aspect-[4/3] w-full overflow-hidden rounded-xl border border-stone-200 bg-stone-100">
        <img
          // Omitted rather than empty when there is no URL: `src=""` resolves to the page itself and
          // fires a spurious request. The alt text and the Clear control still work.
          src={url ?? undefined}
          alt={alt}
          // `object-contain`: the whole leaf stays in frame, whatever the photo's aspect ratio.
          className="absolute inset-0 h-full w-full animate-fade-in object-contain"
        />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="min-w-0 wrap-anywhere text-small text-ink-500">
          <span className="font-medium text-ink-700">{file.name === "" ? "Photo" : file.name}</span>
          {/* `.numeric` keeps the size from jittering as the digits change. */}
          <span className="numeric"> · {formatMegabytes(file.size)} MB</span>
        </p>
        <Button variant="secondary" size="sm" onClick={handleClear} disabled={busy}>
          {clearLabel}
        </Button>
      </div>
    </div>
  );
}

export default ImagePreview;
