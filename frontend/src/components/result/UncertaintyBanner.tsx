import { useId } from "react";

/**
 * The low-confidence advisory, shown beside a diagnosis the models were not sure of (Req 5.6).
 *
 * The requirement is specific about two things, and both are honoured literally.
 *
 * **It appears *alongside* the diagnosis, not instead of it.** The backend already returned its best
 * answer; the banner adds the caveat. Nothing here hides, dims, or replaces the result.
 *
 * **The advice is actionable.** "Low confidence" on its own leaves the user with nowhere to go, so
 * the text names the fix the requirement asks for: retake the photo with the affected area filling
 * more of the frame.
 *
 * The visibility test lives here rather than at the call site — `isUncertain` gates the render and a
 * `false` produces nothing at all, the same shape as `ConfirmDialog`'s `open`. A caller cannot
 * accidentally show this banner on a confident result.
 *
 * Not a live region. The `DiagnosisPage` has one `LiveRegion` that announces the result and this
 * caveat together (Req 12.6); a `role="alert"` here would speak the same sentence twice. Colours are
 * the design's warning pairing, `sun.100` behind `sun.700` at 5.45:1 — above the 4.5:1 floor of
 * Req 12.7, and the meaning is carried by the words, not the tint.
 */

/** The advice itself, exported so a live region or a test can use it without re-typing the copy. */
export const UNCERTAINTY_ADVICE =
  "Retake the photo with the affected area filling more of the frame, in even daylight, and submit it again.";

export interface UncertaintyBannerProps {
  /**
   * `diagnosis.is_uncertain`. Nothing renders when `false`, so the "only when uncertain" half of
   * Req 5.6 holds regardless of what the caller wraps this in.
   */
  isUncertain: boolean;
  /** Extra classes for the wrapper. */
  className?: string;
}

export function UncertaintyBanner({
  isUncertain,
  className,
}: UncertaintyBannerProps): JSX.Element | null {
  const titleId = useId();

  if (!isUncertain) return null;

  return (
    <div
      data-testid="uncertainty-banner"
      role="note"
      aria-labelledby={titleId}
      className={["rounded-xl bg-sun-100 p-5 sm:p-6", className].filter(Boolean).join(" ")}
    >
      <h3 id={titleId} className="text-h3 text-sun-700">
        This one is a low-confidence match
      </h3>
      <p className="mt-2 wrap-anywhere text-body text-sun-700">
        The models were not confident about this diagnosis, so treat it as a possibility rather than
        an answer. {UNCERTAINTY_ADVICE}
      </p>
    </div>
  );
}

export default UncertaintyBanner;
