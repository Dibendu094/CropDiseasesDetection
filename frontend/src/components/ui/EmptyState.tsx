import type { ReactNode } from "react";

/**
 * The "nothing here yet" panel, used by History when the store is empty (Req 9.8) and by the result
 * box before the first submission.
 *
 * An empty state is a dead end unless it says what to do next, so `action` is where the caller puts
 * the route out — on History that is a `<Link to="/diagnosis">`, which is the requirement's whole
 * point. The dashed border reads as "a container waiting for content" rather than a card that
 * failed to load.
 *
 * `icon` is a slot, not a default: the only illustration vocabulary the design permits is the leaf
 * silhouette and simple line icons, and nothing machine-like anywhere (Req 1.6). Leaving it empty is
 * always safe.
 */

export interface EmptyStateProps {
  /** The headline, e.g. "No scans yet". */
  title: ReactNode;
  /** One or two sentences explaining the state. */
  description?: ReactNode;
  /** The route out — normally a `<Link>` or a `<Button>`. */
  action?: ReactNode;
  /** Optional decorative mark above the title. Keep it `aria-hidden`. */
  icon?: ReactNode;
  /** Extra classes for the wrapper. */
  className?: string;
}

/** Default leaf icon for empty states when no custom icon is provided. */
function DefaultIcon(): JSX.Element {
  return (
    <span aria-hidden="true" className="inline-flex h-16 w-16 items-center justify-center rounded-2xl bg-leaf-50 text-leaf-400 animate-float">
      <svg viewBox="0 0 32 32" width="36" height="36" fill="currentColor" focusable="false">
        <path d="M16 2.6c-4.6 4.4-5.6 9.6-2.1 13.4h4.2c3.5-3.8 2.5-9-2.1-13.4Z" />
        <path d="M4.4 8.6c-1 6.2 1.9 10.6 7.1 11.1l2.6-3.3C12.1 11.3 8.8 8.6 4.4 8.6Z" />
        <path d="M27.6 8.6c1 6.2-1.9 10.6-7.1 11.1l-2.6-3.3c2-5.1 5.3-7.8 9.7-7.8Z" />
        <path d="M16 16.4v12.2" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" fill="none" />
      </svg>
    </span>
  );
}

export function EmptyState({
  title,
  description,
  action,
  icon,
  className,
}: EmptyStateProps): JSX.Element {
  return (
    <div
      data-testid="empty-state"
      className={[
        "flex flex-col items-center rounded-2xl border-2 border-dashed border-stone-200",
        "bg-stone-50 px-6 py-14 text-center sm:px-10",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <div className="mb-5">{icon ?? <DefaultIcon />}</div>
      {/* h2: an empty state replaces a whole page section, so it sits at section rank. */}
      <h2 className="wrap-anywhere text-h3 text-ink-900">{title}</h2>
      {description === undefined || description === null || description === "" ? null : (
        // `ink.500` on `stone.100` is 4.78:1 — the lowest body pairing in the system, still above
        // the 4.5:1 floor of Req 12.7.
        <p className="mt-3 max-w-prose wrap-anywhere text-body text-ink-500">{description}</p>
      )}
      {action ? <div className="mt-7">{action}</div> : null}
    </div>
  );
}

export default EmptyState;
