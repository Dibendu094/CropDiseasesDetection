import { useId } from "react";

/**
 * The notice that goes with a placeholder recommendation: the class was predicted, but no guidance
 * resolved for it (Req 7.8).
 *
 * The backend does not fail a prediction over a label it cannot resolve — it returns the diagnosis
 * with a placeholder `RecommendationOut` and `is_placeholder: true`, and the result box states that
 * fact. This is the statement. It says guidance is not available for this class and points at the one
 * person who can fill the gap: a local agricultural expert.
 *
 * In steady state this never renders. Startup verification resolves all 91 labels of both label maps
 * (Req 7.3, 7.4, 7.7), so a placeholder means the data files changed under a checkpoint. That is
 * exactly when a user must not be left with an empty panel and no explanation for it.
 *
 * As with `UncertaintyBanner`, the visibility test is inside the component: `isPlaceholder` false
 * renders nothing, so the notice cannot appear over real guidance. `sun.100` / `sun.700` marks it as
 * a caveat rather than a failure — nothing went wrong with the request, and `clay` is reserved for
 * things that did.
 */

export interface PlaceholderNoticeProps {
  /**
   * `recommendation.is_placeholder`. Nothing renders when `false`, so the "only for the placeholder
   * record" half of Req 7.8 holds regardless of the call site.
   */
  isPlaceholder: boolean;
  /** Extra classes for the wrapper. */
  className?: string;
}

export function PlaceholderNotice({
  isPlaceholder,
  className,
}: PlaceholderNoticeProps): JSX.Element | null {
  const titleId = useId();

  if (!isPlaceholder) return null;

  return (
    <div
      data-testid="placeholder-notice"
      role="note"
      aria-labelledby={titleId}
      className={["rounded-xl bg-sun-100 p-5 sm:p-6", className].filter(Boolean).join(" ")}
    >
      <h3 id={titleId} className="text-h3 text-sun-700">
        No treatment guidance for this class
      </h3>
      <p className="mt-2 wrap-anywhere text-body text-sun-700">
        Treatment guidance is not available for this class yet. The diagnosis above still stands —
        confirm it with a local agricultural expert, and take their advice on treatment before
        applying anything.
      </p>
    </div>
  );
}

export default PlaceholderNotice;
