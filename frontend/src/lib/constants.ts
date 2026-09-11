/**
 * Values that more than one module has to agree on.
 *
 * Three groups live here:
 *
 * - the upload limit and accepted MIME types, mirroring `Settings.max_upload_bytes` and the
 *   backend's format sniff so the client-side rejection in `validateImage.ts` states the same
 *   limit the server enforces (Req 4.3, 4.4);
 * - `ROUTES`, the single source of truth for both the `Navbar` and the route table in `App.tsx`,
 *   so a link and a route cannot drift apart (Req 1.2, 1.3);
 * - the not-found path used by the catch-all route (Req 1.5).
 */

// --- uploads ------------------------------------------------------------------------

/** One megabyte, binary. The backend counts in the same units. */
export const BYTES_PER_MB = 1024 * 1024;

/** Max_Upload_Size in MB, as stated to the user. */
export const MAX_UPLOAD_MB = 10;

/**
 * Max_Upload_Size in bytes: 10,485,760. Matches `Settings.max_upload_bytes` exactly, so a file
 * the client accepts is never rejected by the server for size alone (Property 14).
 */
export const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * BYTES_PER_MB;

/** The only MIME types the file picker offers and `validateImage` accepts (Req 4.1). */
export const ACCEPTED_MIME = ["image/jpeg", "image/png", "image/webp"] as const;

/** One of the three accepted MIME types. */
export type AcceptedMime = (typeof ACCEPTED_MIME)[number];

/** Value for the `accept` attribute of `<input type="file">`. */
export const ACCEPTED_MIME_ATTR: string = ACCEPTED_MIME.join(",");

/**
 * The accepted formats as prose, matching the backend's 415 message so the two sides of the
 * boundary word the rejection identically (Req 4.2).
 */
export const ACCEPTED_FORMATS_LABEL = "JPEG, PNG, and WebP";

/** Narrowing helper: `true` when `type` is one of the accepted MIME types. */
export function isAcceptedMime(type: string): type is AcceptedMime {
  return (ACCEPTED_MIME as readonly string[]).includes(type);
}

// --- routing ------------------------------------------------------------------------

/** Every routable path with a navigation link. The catch-all is `NOT_FOUND_PATH`. */
export type RoutePath = "/" | "/diagnosis" | "/history";

/** One navigable route: the path it resolves to and the label shown in the `Navbar`. */
export interface NavRoute<P extends RoutePath = RoutePath> {
  readonly path: P;
  readonly label: string;
}

/**
 * The three navigation targets, in the order the `Navbar` renders them.
 *
 * The annotation is a fixed-length tuple over the three literal paths, so this list cannot gain a
 * fourth entry, lose one, or point somewhere undeclared without a type error. That is what keeps
 * "exactly three navigation links" (Req 1.2) true of both the navbar and the route table, since
 * both map over this array.
 */
export const ROUTES: readonly [NavRoute<"/">, NavRoute<"/diagnosis">, NavRoute<"/history">] = [
  { path: "/", label: "Home" },
  { path: "/diagnosis", label: "Diagnosis" },
  { path: "/history", label: "History" },
];

/** React Router's catch-all pattern, rendering the not-found view (Req 1.5). */
export const NOT_FOUND_PATH = "*";
