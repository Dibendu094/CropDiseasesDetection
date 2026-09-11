/**
 * The only place in the app that calls `fetch`.
 *
 * Every method funnels through `request`, so the 60 s timeout (Req 6.7), the single error
 * envelope, and the "prefer the backend's message" rule (Req 10.7) hold for every endpoint
 * — including ones added later — without a caller having to remember them.
 *
 * Callers catch `ApiClientError` and render `error.message`; they never see a raw
 * `Response`, a `TypeError` from a refused connection, or an `AbortError`.
 */

import {
  ApiClientError,
  MALFORMED_MESSAGE,
  TIMEOUT_MESSAGE,
  UNREACHABLE_MESSAGE,
  fallbackForStatus,
  readErrorEnvelope,
} from "./errors";
import type {
  ClassMetadata,
  HealthResponse,
  HistoryListResponse,
  PredictResponse,
  ScanDetail,
} from "./types";

/**
 * Backend origin. When empty or unset in development, relative URLs are used so Vite's dev-server
 * proxy forwards `/api` directly to `http://127.0.0.1:8000`, eliminating CORS and port resolution issues.
 */
const BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.trim() ?? "";

/** Trailing slashes are stripped so `${BASE}${path}` never produces `//api/...`. */
const BASE_URL = BASE.replace(/\/+$/, "");

/** Req 6.7: no response within 60 seconds is a timeout. */
export const TIMEOUT_MS = 60_000;

/** `AbortError` arrives as a `DOMException` in browsers and as a plain `Error` elsewhere. */
function isAbortError(value: unknown): boolean {
  return value instanceof Error && value.name === "AbortError";
}

/** Builds the `http` failure for a non-2xx response, preferring the backend's message. */
async function httpError(res: Response): Promise<ApiClientError> {
  const body: unknown = await res.json().catch(() => null);
  const { code, message } = readErrorEnvelope(body);
  return new ApiClientError("http", res.status, code, message ?? fallbackForStatus(res.status));
}

/** Parses a 2xx body; an unreadable body is a `malformed` failure, not a crash. */
async function parseJson<T>(res: Response): Promise<T> {
  try {
    return (await res.json()) as T;
  } catch {
    throw new ApiClientError("malformed", res.status, "MALFORMED_RESPONSE", MALFORMED_MESSAGE);
  }
}

/**
 * Performs one request and normalises every outcome to either `T` or an `ApiClientError`.
 *
 * `fetch` is referenced by name at call time rather than captured at module load, so a test
 * can swap the global before calling. The `finally` clears the timer on every path,
 * including the success path, so a pending timeout cannot abort a later request.
 */
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, TIMEOUT_MS);

  try {
    const res = await fetch(`${BASE_URL}${path}`, { ...init, signal: controller.signal });
    // 204 has no body: DELETE succeeds here, and `res.json()` would throw.
    if (res.status === 204) return undefined as T;
    if (!res.ok) throw await httpError(res);
    return await parseJson<T>(res);
  } catch (e) {
    if (e instanceof ApiClientError) throw e;
    if (timedOut || isAbortError(e)) {
      throw new ApiClientError("timeout", null, "TIMEOUT", TIMEOUT_MESSAGE);
    }
    // Anything left is a transport failure: refused connection, DNS, CORS, offline.
    throw new ApiClientError("network", null, "UNREACHABLE", UNREACHABLE_MESSAGE);
  } finally {
    clearTimeout(timer);
  }
}

export const api = {
  /**
   * `POST /api/predict` with the image as the `file` part and an optional `crop` part.
   *
   * `FormData` sets its own `Content-Type` with the multipart boundary, so no header is set
   * here — doing so would strip the boundary and the backend would reject the body.
   *
   * The `crop` part is appended **only when a non-empty crop is given**, because the backend
   * treats the field's absence as "detect automatically" and restricts the prediction to one
   * crop's classes whenever it is present. Sending `crop=""` would be a different request from
   * sending no crop at all, and the empty string is exactly what the picker's "not sure" option
   * yields — so the check is here, once, rather than at each call site. The applied value comes
   * back as `meta.crop_filter`.
   */
  predict: (file: File, crop?: string): Promise<PredictResponse> => {
    const fd = new FormData();
    fd.append("file", file);
    if (crop !== undefined && crop.trim() !== "") fd.append("crop", crop);
    return request<PredictResponse>("/api/predict", { method: "POST", body: fd });
  },

  /** `GET /api/history` — newest first, paged. */
  history: (limit = 50, offset = 0): Promise<HistoryListResponse> =>
    request<HistoryListResponse>(`/api/history?limit=${limit}&offset=${offset}`),

  /**
   * `GET /api/history/{id}` — the full detail for one scan: the list row plus its candidates and
   * resolved guidance.
   *
   * Separate from `history` rather than folded into it: the list carries a dozen rows and has no use
   * for a dozen 12-section recommendation blocks, so the guidance is fetched only for the scan a user
   * actually opens. A `404` means the entry is gone, which is the same message the delete path shows.
   */
  scan: (id: string): Promise<ScanDetail> =>
    request<ScanDetail>(`/api/history/${encodeURIComponent(id)}`),

  /** `DELETE /api/history/{id}` — `204` on success, `404` for an unknown id. */
  deleteScan: (id: string): Promise<void> =>
    request<void>(`/api/history/${encodeURIComponent(id)}`, { method: "DELETE" }),

  /** `DELETE /api/history` — `204` on success, deletes all saved scans and images. */
  deleteAllHistory: (): Promise<void> =>
    request<void>("/api/history", { method: "DELETE" }),

  /** `GET /api/meta/classes` — crop counts, threshold, upload limits. */
  metadata: (): Promise<ClassMetadata> => request<ClassMetadata>("/api/meta/classes"),

  /** `GET /api/health` — always `200`, so "app up, models down" is visible. */
  health: (): Promise<HealthResponse> => request<HealthResponse>("/api/health"),

  /** Absolute URL for a stored scan image, for use as an `<img src>`. */
  imageUrl: (id: string): string => `${BASE_URL}/api/history/${encodeURIComponent(id)}/image`,
};
