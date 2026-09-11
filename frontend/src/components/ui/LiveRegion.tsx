/**
 * The one announcement channel per page (Req 12.6).
 *
 * `aria-live="polite"` waits for a pause rather than cutting the user off, and `aria-atomic="true"`
 * makes the whole message read as a unit — without it a screen reader may announce only the words
 * that changed, which turns "Late blight on Potato, 93.1% confidence" into a fragment when the next
 * result differs by one field.
 *
 * The node has to be in the document **before** the message arrives; a region that mounts together
 * with its text is frequently not announced at all. So this renders unconditionally with an empty
 * string, and the pages update `message` — which is why `Spinner` and `ErrorNotice` are not live
 * regions themselves.
 *
 * Visually hidden by default. `sr-only` rather than `display: none` or `hidden`, because a hidden
 * subtree is skipped by assistive technology entirely.
 */

export interface LiveRegionProps {
  /** The text to announce. Changing it announces the new value; `""` announces nothing. */
  message?: string;
  /** Render the message on screen as well, e.g. a status line under the upload panel. */
  visible?: boolean;
  /** `id`, when a control needs to point at the region. */
  id?: string;
  /** Extra classes, applied only when `visible`. */
  className?: string;
}

export function LiveRegion({
  message = "",
  visible = false,
  id,
  className,
}: LiveRegionProps): JSX.Element {
  return (
    <div
      id={id}
      data-testid="live-region"
      // `role="status"` implies a polite live region; both are set so older screen readers that
      // honour only one of the two still announce.
      role="status"
      aria-live="polite"
      aria-atomic={true}
      className={
        visible
          ? ["wrap-anywhere text-small text-ink-500", className].filter(Boolean).join(" ")
          : "sr-only"
      }
    >
      {message}
    </div>
  );
}

export default LiveRegion;
