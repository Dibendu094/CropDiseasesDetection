import type { HTMLAttributes, ReactNode } from "react";

/**
 * A small label chip: the model identifier on a result, the crop chips on Home, "No disease
 * detected" on a healthy outcome, "Uncertain" beside a low-confidence diagnosis.
 *
 * Each tone pairs a tinted background with its own text colour from the design's contrast table, so
 * every chip clears the 4.5:1 floor of Req 12.7 as small text:
 *
 * | Tone      | Background   | Text        | Contrast |
 * | --------- | ------------ | ----------- | -------- |
 * | `neutral` | `stone.100`  | `ink.700`   | 9.01:1   |
 * | `leaf`    | `leaf.100`   | `leaf.700`  | 6.39:1   |
 * | `sun`     | `sun.100`    | `sun.700`   | 5.45:1   |
 * | `clay`    | `clay.100`   | `clay.700`  | 6.18:1   |
 *
 * A badge never carries meaning through its colour alone — the text says which state it is, which
 * is the same rule the confidence meter follows.
 */

export type BadgeTone = "neutral" | "leaf" | "sun" | "clay";

const TONE_CLASSES: Readonly<Record<BadgeTone, string>> = {
  neutral: "bg-stone-100 text-ink-700 border border-stone-200",
  leaf:    "bg-leaf-100 text-leaf-700 border border-leaf-200",
  sun:     "bg-sun-100 text-sun-700 border border-sun-100",
  clay:    "bg-clay-100 text-clay-700 border border-clay-200",
};

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  /** Colour role. Defaults to `neutral`. */
  tone?: BadgeTone;
  /** Leading icon or dot. Decorative — keep it `aria-hidden`. */
  icon?: ReactNode;
  children?: ReactNode;
}

export function Badge({ tone = "neutral", icon, className, children, ...rest }: BadgeProps): JSX.Element {
  return (
    <span
      className={[
        "inline-flex max-w-full items-center gap-1.5 rounded-full px-3 py-1",
        "wrap-anywhere text-caption font-semibold tracking-wide",
        TONE_CLASSES[tone],
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      {...rest}
    >
      {icon}
      {children}
    </span>
  );
}

export default Badge;
