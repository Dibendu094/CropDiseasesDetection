import { useId, type ReactNode } from "react";

import { Button } from "./Button";

/**
 * The failure panel: the message the backend sent, plus a retry control (Req 10.7).
 *
 * `message` is required and is rendered verbatim. That is the requirement — the backend's wording
 * wins over any local string, which is what makes the panel correct for status codes added later.
 * `api/errors.ts` guarantees a non-empty message for every failure kind, so there is no empty-panel
 * case to handle here.
 *
 * `onRetry` is optional only because a few failures are not retryable by the same request — a 415 on
 * a file the user must replace, for example. Whenever the same call could succeed on a second
 * attempt, pass it: an error with no way forward is where a user gets stuck.
 *
 * Not a live region by default. The page's `LiveRegion` announces the message (Req 12.6); a
 * `role="alert"` here as well would speak it twice. `announce` covers the standalone case.
 *
 * Colours are the design's error pairing: `clay.100` surface with `clay.700` text at 6.18:1.
 * Enhanced with a left accent border and error icon for better visual hierarchy.
 */

export interface ErrorNoticeProps {
  /** The message to display — normally `ApiClientError.message`. Rendered as sent. */
  message: string;
  /** Panel heading. Defaults to "Something went wrong". */
  title?: string;
  /** Retry handler. Omit only when retrying the same request cannot help. */
  onRetry?: () => void;
  /** Retry button label. Defaults to "Try again". */
  retryLabel?: string;
  /** Retry in flight: the button shows a spinner and cannot be pressed again. */
  retrying?: boolean;
  /** Expose the panel as an assertive live region. Leave unset when the page has a `LiveRegion`. */
  announce?: boolean;
  /** Extra detail below the message, e.g. a hint about the photo. */
  children?: ReactNode;
  /** Extra classes for the wrapper. */
  className?: string;
}

/** Error icon — decorative, aria-hidden. */
function ErrorIcon(): JSX.Element {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 20 20"
      fill="currentColor"
      className="h-5 w-5 shrink-0 text-clay-600"
    >
      <path
        fillRule="evenodd"
        d="M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0Zm-8-5a.75.75 0 0 1 .75.75v4.5a.75.75 0 0 1-1.5 0v-4.5A.75.75 0 0 1 10 5Zm0 10a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z"
        clipRule="evenodd"
      />
    </svg>
  );
}

export function ErrorNotice({
  message,
  title = "Something went wrong",
  onRetry,
  retryLabel = "Try again",
  retrying = false,
  announce = false,
  children,
  className,
}: ErrorNoticeProps): JSX.Element {
  const titleId = useId();

  return (
    <div
      data-testid="error-notice"
      role={announce ? "alert" : "group"}
      aria-labelledby={titleId}
      className={[
        "rounded-2xl border border-clay-200 bg-clay-100 p-5 sm:p-6",
        "border-l-4 border-l-clay-600",
        className,
      ].filter(Boolean).join(" ")}
    >
      <div className="flex items-start gap-3">
        <ErrorIcon />
        <div className="min-w-0 flex-1">
          <h3 id={titleId} className="text-h3 text-clay-700">
            {title}
          </h3>
          <p className="mt-2 wrap-anywhere text-body text-clay-700">{message}</p>
          {children ? <div className="mt-2 wrap-anywhere text-small text-clay-600">{children}</div> : null}
          {onRetry ? (
            <div className="mt-5">
              {/* Secondary rather than destructive: retrying is the safe action, and green-on-red would
                  read as a confirmation of the error. */}
              <Button variant="secondary" onClick={onRetry} loading={retrying} size="sm">
                {retryLabel}
              </Button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export default ErrorNotice;
