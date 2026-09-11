import { useId } from "react";

import type { DiagnosisOut } from "../../api/types";
import { Badge, ConfidenceMeter } from "../ui";

/**
 * The top of a result: what was found, on which crop, and how sure the prediction is
 * (Req 5.6, 8.2, 11.7).
 *
 * Three decisions are worth stating, because each of them is a requirement rather than a preference.
 *
 * **The confidence figure is the backend's.** `percent` is `diagnosis.confidence_percent`, the
 * computed field the API always sends, passed straight through to `ConfidenceMeter`. It is never
 * re-derived from `diagnosis.confidence` here — that is precisely how the result card and the
 * history list end up one decimal apart on the same scan.
 *
 * **The Hindi crop name is secondary and conditional.** Req 8.2 asks for it adjacent to the English
 * name *where it is non-empty*, and the backend sends `""` when the data files have none. It is
 * tested after trimming, so a whitespace-only value renders nothing rather than an empty span with
 * margins around it. The span carries `lang="hi"` so a screen reader switches voice instead of
 * reading Devanagari through an English one.
 *
 * **Model identity is deliberately not surfaced.** Which checkpoint produced the result is an
 * implementation detail a grower has no use for, so nothing here renders it. `diagnosis.model_used`
 * stays in the payload for logs and debugging. Uncertainty, by contrast, is the grower's business:
 * the "Uncertain" chip says the word rather than relying on colour, and the advisory that goes with
 * it is `UncertaintyBanner`'s job (Req 5.6).
 *
 * `accent` only swaps the surface, `plain` (white on a `stone.200` hairline) for a disease and `leaf`
 * (`leaf.50` on `leaf.100`) for a healthy outcome. The surface is written out rather than layered
 * over `Card`: two competing `bg-*` classes at equal specificity resolve by stylesheet order, which
 * is not something a component should be betting on.
 */

/** Surface tint. `leaf` is the healthy variant used by `HealthyResult` (Req 7.10). */
export type DiagnosisAccent = "plain" | "leaf";

const ACCENT_CLASSES: Readonly<Record<DiagnosisAccent, string>> = {
  plain: "border-stone-200 bg-white shadow-md",
  leaf:  "border-leaf-200 bg-gradient-to-br from-leaf-50 to-white shadow-md shadow-leaf-100/50",
};

export interface DiagnosisHeaderProps {
  /** The single diagnosis for the submitted image. */
  diagnosis: DiagnosisOut;
  /** Surface tint. Defaults to `plain`. */
  accent?: DiagnosisAccent;
  /**
   * `id` for the display-name heading, for a `<section aria-labelledby>` around the result. One is
   * generated when omitted, so the heading always has a referenceable id.
   */
  headingId?: string;
  /** Extra classes for the wrapper. */
  className?: string;
}

export function DiagnosisHeader({
  diagnosis,
  accent = "plain",
  headingId,
  className,
}: DiagnosisHeaderProps): JSX.Element {
  const generatedId = useId();
  const titleId = headingId ?? generatedId;

  const cropHindi = diagnosis.crop_hindi.trim();
  const crop = diagnosis.crop.trim();

  return (
    <header
      data-testid="diagnosis-header"
      className={[
        "rounded-2xl border p-5 sm:p-6",
        ACCENT_CLASSES[accent],
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h2 id={titleId} className="wrap-anywhere text-h2 text-ink-900">
            {diagnosis.display_name}
          </h2>
          {crop === "" ? null : (
            <p className="mt-1.5 wrap-anywhere text-body-lg text-ink-500">
              <span className="sr-only">Crop: </span>
              <span data-testid="diagnosis-crop" className="font-medium text-ink-700">{crop}</span>
              {/* Secondary, adjacent, and only when the data actually carries it (Req 8.2). */}
              {cropHindi === "" ? null : (
                <span data-testid="diagnosis-crop-hindi" lang="hi" className="ml-2 text-ink-400">
                  {cropHindi}
                </span>
              )}
            </p>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2 sm:shrink-0 sm:justify-end">
          {diagnosis.is_uncertain ? (
            <Badge data-testid="diagnosis-uncertain" tone="sun">
              Uncertain
            </Badge>
          ) : null}
          {diagnosis.is_healthy ? (
            <Badge tone="leaf">Healthy</Badge>
          ) : null}
        </div>
      </div>

      {/* The backend's `confidence_percent`, unmodified (Req 11.7). */}
      <ConfidenceMeter
        className="mt-6"
        percent={diagnosis.confidence_percent}
        tone={diagnosis.is_uncertain ? "sun" : "leaf"}
      />
    </header>
  );
}

export default DiagnosisHeader;
