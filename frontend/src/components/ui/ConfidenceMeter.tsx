import { useId } from "react";

import { formatPercent, roundToOneDecimal } from "../../lib/format";

/**
 * Confidence as a labelled percentage next to a proportional bar (Req 11.7).
 *
 * Three rules hold this component together.
 *
 * **The number is not re-derived.** `percent` is the backend's `confidence_percent`, already rounded
 * server-side, and it is displayed as given. Recomputing it here from a raw softmax score is how the
 * result card and the history list end up one decimal apart on the same scan.
 *
 * **`aria-valuenow` is the number on screen.** Both come from the same clamped value, so a screen
 * reader and a sighted user never read different figures.
 *
 * **Colour carries nothing.** The percentage is text, and low confidence is stated by the
 * uncertainty banner (Req 5.6), not by the bar turning warm. `tone` only tints the fill to match a
 * surrounding panel; removing it would lose no information.
 *
 * The fill uses a gradient from a lighter to a deeper green/amber, animated with a spring ease
 * for a premium feel. Width is inline because the value is a runtime number.
 */

export type ConfidenceTone = "leaf" | "sun";

/** Bar height per size, `sm` for the denser history card. */
const TRACK_CLASSES = {
  sm: "h-2",
  md: "h-2.5",
} as const;

export type ConfidenceMeterSize = keyof typeof TRACK_CLASSES;

const FILL_GRADIENT: Readonly<Record<ConfidenceTone, string>> = {
  leaf: "linear-gradient(90deg, #1E7340 0%, #2E8F52 60%, #48A96A 100%)",
  sun:  "linear-gradient(90deg, #8A5206 0%, #A9640A 60%, #C97A10 100%)",
};

const GLOW_CLASSES: Readonly<Record<ConfidenceTone, string>> = {
  leaf: "shadow-glow-sm",
  sun:  "shadow-[0_0_8px_rgb(169_100_10_/_0.30)]",
};

export interface ConfidenceMeterProps {
  /**
   * The backend's `confidence_percent`, a percentage in `[0, 100]`. Values outside the range are
   * clamped and a non-finite value reads as `0`, so a malformed field cannot produce a bar wider
   * than its track or an `aria-valuenow` outside its own min/max.
   */
  percent: number;
  /** Visible label and accessible name. Defaults to "Confidence". */
  label?: string;
  /** Fill tint. Defaults to `leaf`; carries no meaning of its own. */
  tone?: ConfidenceTone;
  /** Bar height. Defaults to `md`. */
  size?: ConfidenceMeterSize;
  /**
   * Animate the fill on first paint. Defaults to `true`; the global reduced-motion block collapses
   * it for anyone who asked for less motion (Req 11.6).
   */
  animate?: boolean;
  /** Extra classes for the wrapper. */
  className?: string;
}

export function ConfidenceMeter({
  percent,
  label = "Confidence",
  tone = "leaf",
  size = "md",
  animate = true,
  className,
}: ConfidenceMeterProps): JSX.Element {
  const labelId = useId();

  // One clamp, one rounding, used by the text, the ARIA value, and the width alike.
  const safe = Number.isFinite(percent) ? Math.min(100, Math.max(0, percent)) : 0;
  const value = roundToOneDecimal(safe);
  const percentText = formatPercent(safe);

  return (
    <div
      data-testid="confidence-meter"
      className={["w-full", className].filter(Boolean).join(" ")}
    >
      <div className="mb-2.5 flex items-baseline justify-between gap-2">
        <span id={labelId} className="text-small font-semibold text-ink-500 uppercase tracking-wide">
          {label}
        </span>
        {/* `numeric` keeps the digits on a fixed advance, so a column of these does not jitter. */}
        <span
          data-testid="confidence-value"
          className="numeric text-body font-bold text-ink-900"
        >
          {percentText}
        </span>
      </div>
      {/* Track */}
      <div
        role="progressbar"
        aria-labelledby={labelId}
        aria-valuenow={value}
        aria-valuemin={0}
        aria-valuemax={100}
        // Screen readers otherwise announce a bare "94.3"; this reads it as the label does.
        aria-valuetext={`${percentText} ${label.toLowerCase()}`}
        className={`${TRACK_CLASSES[size]} w-full overflow-hidden rounded-full bg-stone-200`}
      >
        <div
          data-testid="confidence-fill"
          className={[
            "h-full rounded-full origin-left",
            animate ? "animate-meter-fill" : "",
            GLOW_CLASSES[tone],
          ]
            .filter(Boolean)
            .join(" ")}
          // Gradient fill, inline because the value is runtime.
          style={{
            width: `${value}%`,
            background: FILL_GRADIENT[tone],
          }}
        />
      </div>
    </div>
  );
}

export default ConfidenceMeter;
