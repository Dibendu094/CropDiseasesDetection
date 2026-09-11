/**
 * Client-side pre-validation of a selected image (Req 4.4).
 *
 * Runs before any network call, in every intake path — drop zone, file picker, camera capture — so
 * an oversize or unsupported file never leaves the browser. The backend re-checks both, since this
 * side can be bypassed; the point here is a fast, specific message rather than a 413 round trip
 * (Property 14).
 *
 * The function is pure and total: it reads `size` and `type` off the file and returns a result. It
 * never throws, never touches the network, and never reads the file's bytes — a real format check
 * needs the container signature, which is the server's job.
 */

import {
  ACCEPTED_FORMATS_LABEL,
  MAX_UPLOAD_BYTES,
  MAX_UPLOAD_MB,
  isAcceptedMime,
} from "./constants";
import { formatMegabytes } from "./format";

/** Why a file was rejected. `size` is checked first, so a file can fail for only one reason. */
export type ImageRejectionReason = "size" | "type";

export interface ImageAccepted {
  readonly ok: true;
}

export interface ImageRejected {
  readonly ok: false;
  readonly reason: ImageRejectionReason;
  /** User-facing text, ready to render as-is. Never empty. */
  readonly message: string;
}

export type ImageValidationResult = ImageAccepted | ImageRejected;

/**
 * The parts of a `File` this check reads. A `File` satisfies it structurally, and so does a plain
 * object, which is what lets the size sweep in the tests run without allocating 10 MB buffers.
 */
export interface ValidatableImage {
  readonly size: number;
  readonly type: string;
}

const ACCEPTED: ImageAccepted = { ok: true };

/**
 * Validate a selected file against Max_Upload_Size and the accepted MIME types.
 *
 * Size is checked first and reported with the file's actual size, because "too big" is the failure
 * a user can act on ("That image is larger than the 10 MB limit (yours is 14.2 MB)."). The boundary
 * is inclusive: exactly {@link MAX_UPLOAD_BYTES} bytes is accepted, matching the backend, which
 * rejects only once the accumulated length *exceeds* the cap.
 *
 * A `size` that is not a finite number is not treated as oversize — there is nothing to compare —
 * and validation falls through to the MIME check.
 */
export function validateImage(file: ValidatableImage): ImageValidationResult {
  const size = typeof file.size === "number" && Number.isFinite(file.size) ? file.size : 0;

  if (size > MAX_UPLOAD_BYTES) {
    return {
      ok: false,
      reason: "size",
      message:
        `That image is larger than the ${MAX_UPLOAD_MB} MB limit ` +
        `(yours is ${formatMegabytes(size)} MB).`,
    };
  }

  const type = typeof file.type === "string" ? file.type.trim().toLowerCase() : "";

  if (!isAcceptedMime(type)) {
    return {
      ok: false,
      reason: "type",
      message: `Only ${ACCEPTED_FORMATS_LABEL} images are accepted.`,
    };
  }

  return ACCEPTED;
}
