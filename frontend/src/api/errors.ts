/**
 * The single error type the UI catches, plus the local fallback strings.
 *
 * Every call in `client.ts` fails with an `ApiClientError`, so a component has one type to
 * narrow on and one non-empty `message` to render next to a retry control (Req 10.7).
 *
 * `kind` says where the failure came from, which is what the UI branches on when it needs
 * more than a message:
 *
 * | `kind`      | Meaning                                              | `status` | `code`               |
 * | ----------- | ---------------------------------------------------- | -------- | -------------------- |
 * | `http`      | The backend answered with a non-2xx status           | the code | backend code or null |
 * | `timeout`   | No response within 60 s (Req 6.7)                    | `null`   | `TIMEOUT`            |
 * | `network`   | The request never reached the backend (Req 10.8)     | `null`   | `UNREACHABLE`        |
 * | `malformed` | A 2xx response whose body was not readable JSON      | the code | `MALFORMED_RESPONSE` |
 */

import type { ErrorResponse } from "./types";

/** Where a failure came from. */
export type ApiErrorKind = "http" | "timeout" | "network" | "malformed";

/**
 * Local message per status, used **only** when the backend body is missing or malformed.
 *
 * The backend's own `error.message` always wins (Req 10.7), so these strings are the
 * safety net for a proxy error page, a truncated body, or a status the backend gained
 * later. Wording tracks the taxonomy in `backend/app/errors.py` so the fallback reads the
 * same as the real thing.
 */
export const FALLBACK_BY_STATUS: Record<number, string> = {
  400: "The request was rejected. Attach a photo and try again.",
  404: "That history entry does not exist.",
  413: "That image is larger than the 10 MB limit. Please use a smaller photo.",
  415: "Only JPEG, PNG, and WebP images are accepted.",
  422: "That image could not be read. It may be incomplete or corrupted.",
  500: "Something went wrong while analysing the image. Please try again.",
  503: "The diagnosis service is unavailable. No model is loaded.",
};

/** Used for any status outside `FALLBACK_BY_STATUS` when the body carried no message. */
export const GENERIC_ERROR_MESSAGE = "The request failed. Please try again.";

/** Shown when the 60 s budget of Req 6.7 elapses. */
export const TIMEOUT_MESSAGE = "The diagnosis is taking longer than 60 seconds. Please try again.";

/** Shown when the request never reached the backend (Req 10.8). */
export const UNREACHABLE_MESSAGE =
  "The server is unreachable. Check that the backend is running and try again.";

/** Shown when a 2xx response body could not be parsed as JSON. */
export const MALFORMED_MESSAGE =
  "The server sent a response the app could not read. Please try again.";

/** The single failure type raised by every `api.*` call. */
export class ApiClientError extends Error {
  constructor(
    readonly kind: ApiErrorKind,
    readonly status: number | null,
    readonly code: string | null,
    message: string,
  ) {
    super(message);
    this.name = "ApiClientError";
  }
}

/** Narrowing helper for `catch` blocks, which receive `unknown`. */
export function isApiClientError(value: unknown): value is ApiClientError {
  return value instanceof ApiClientError;
}

/**
 * The local message for a status. Never empty, for any status, which is the client half of
 * Property 36.
 */
export function fallbackForStatus(status: number): string {
  return FALLBACK_BY_STATUS[status] ?? GENERIC_ERROR_MESSAGE;
}

/**
 * Whether a parsed body is the backend's error envelope:
 * `{ "error": { "code": string, "message": string } }`.
 *
 * Anything else — `null`, an array, a bare string, a missing `error`, non-string members —
 * is malformed as far as the client is concerned, and the caller falls back by status.
 */
export function isErrorResponse(body: unknown): body is ErrorResponse {
  if (typeof body !== "object" || body === null) return false;
  const { error } = body as { error?: unknown };
  if (typeof error !== "object" || error === null) return false;
  const { code, message } = error as { code?: unknown; message?: unknown };
  return typeof code === "string" && typeof message === "string";
}

/**
 * Pulls `code` and `message` out of a body that may or may not be the envelope.
 *
 * A blank message counts as absent so the caller falls back to a status message rather
 * than rendering an empty error panel; a recognised `code` is kept either way, because it
 * is still the most accurate thing to report.
 */
export function readErrorEnvelope(body: unknown): {
  code: string | null;
  message: string | null;
} {
  if (!isErrorResponse(body)) return { code: null, message: null };
  return {
    code: body.error.code.trim() || null,
    message: body.error.message.trim() || null,
  };
}
