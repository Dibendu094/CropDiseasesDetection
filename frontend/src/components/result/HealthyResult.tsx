import { useId } from "react";

import type { DiagnosisOut, RecommendationOut } from "../../api/types";
import { Badge } from "../ui";
import { RecommendationSections } from "./RecommendationSections";

/**
 * The healthy-plant outcome (Req 7.10).
 *
 * This is a *variant of the result*, not a page of its own — the diagnosis header, the confidence
 * meter, the candidates, and the small print above and below it are exactly the same components a
 * diseased result uses. What changes is three things the requirement names:
 *
 * 1. the accent is `leaf` rather than the neutral surface, so a healthy scan reads as good news
 *    before a word of it is read;
 * 2. a "No disease detected" badge states the outcome in text, because colour alone must not carry
 *    it;
 * 3. the chemical spray section is dropped entirely. Not collapsed, not empty — `isHealthy` on
 *    `RecommendationSections` means the branch never produces it.
 *
 * Everything else in the guidance is kept, and that is deliberate: prevention, fertilizer, and field
 * tips are the whole point of a healthy result. A user who photographs a healthy leaf is asking "what
 * do I do to keep it this way", and an empty panel is a worse answer than none.
 *
 * `leaf.50` behind `ink.700` body text is 9.6:1, and the `leaf` badge pairing is 6.39:1 — both above
 * the 4.5:1 floor of Req 12.7.
 */

/** The outcome, in words. Exported so a live region or a test can reuse the exact string. */
export const HEALTHY_BADGE_LABEL = "No disease detected";

export interface HealthyResultProps {
  /** The diagnosis, used for the crop name in the headline. */
  diagnosis: DiagnosisOut;
  /** The resolved guidance, rendered with the chemical spray section dropped. */
  recommendation: RecommendationOut;
  /** Extra classes for the wrapper. */
  className?: string;
}

export function HealthyResult({
  diagnosis,
  recommendation,
  className,
}: HealthyResultProps): JSX.Element {
  const headingId = useId();

  // The crop is the subject of the sentence; the display name is the fallback when the label carried
  // no separate crop, so the headline is never "  looks healthy".
  const crop = diagnosis.crop.trim();
  const subject = crop === "" ? diagnosis.display_name : crop;

  return (
    <div
      data-testid="healthy-result"
      className={["space-y-4", className].filter(Boolean).join(" ")}
    >
      <section
        aria-labelledby={headingId}
        className="rounded-xl border border-leaf-100 bg-leaf-50 p-5 shadow-sm sm:p-6"
      >
        <Badge tone="leaf">{HEALTHY_BADGE_LABEL}</Badge>
        <h3 id={headingId} className="mt-3 wrap-anywhere text-h3 text-leaf-700">
          This {subject} looks healthy
        </h3>
        <p className="mt-2 wrap-anywhere text-body text-ink-700">
          No disease was detected in this photo, so there is nothing to treat and no spray section
          below. The guidance that follows is about keeping the crop this way.
        </p>
      </section>

      {/* `isHealthy` is what drops the chemical spray section — the one behavioural difference. */}
      <RecommendationSections recommendation={recommendation} isHealthy />
    </div>
  );
}

export default HealthyResult;
