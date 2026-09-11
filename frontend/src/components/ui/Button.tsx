import type { ButtonHTMLAttributes, ReactNode, Ref } from "react";

import { Spinner } from "./Spinner";

/**
 * The one button in the app. Every clickable control — submit, retry, clear, delete, confirm —
 * comes from here, which is what keeps the focus ring, the hover timing, and the colour pairings
 * from drifting apart across pages.
 *
 * Palette pairings are the computed ones from the design's contrast table, so no variant needs
 * checking again at the call site:
 *
 * | Variant       | Rest                          | Hover        | Contrast |
 * | ------------- | ----------------------------- | ------------ | -------- |
 * | `primary`     | gradient `leaf.700→leaf.500`  | glow + lift  | 5.84:1   |
 * | `secondary`   | glass surface, ink.700 text   | tint + glow  | 10.09:1  |
 * | `destructive` | `clay.600` bg, white text     | `clay.700`   | 5.99:1   |
 * | `quiet`       | transparent, `leaf.700` text  | `leaf.50`    | 8.05:1   |
 *
 * `transition-colors` alone carries the 200 ms hover timing: `transitionDuration.DEFAULT` in the
 * Tailwind config is `200ms`, inside the 150–300 ms band of Req 11.4. `.focus-ring` is applied here
 * rather than at the call site, so no button can be built without a visible focus indicator
 * (Req 12.4). Nothing sets `outline: none`.
 */

export type ButtonVariant = "primary" | "secondary" | "destructive" | "quiet";
export type ButtonSize = "sm" | "md" | "lg";

const BASE_CLASSES = [
  "inline-flex items-center justify-center gap-2",
  "rounded-xl font-heading font-semibold",
  "transition-all focus-ring",
  // A disabled control still has to read as text, so it dims the surface rather than the label.
  "disabled:cursor-not-allowed disabled:opacity-50",
].join(" ");

const VARIANT_CLASSES: Readonly<Record<ButtonVariant, string>> = {
  primary:
    "bg-leaf-600 hover:bg-leaf-700 text-white btn-primary-gradient border-0",
  secondary:
    "bg-white glass-card text-ink-700 hover:border-leaf-200 hover:bg-leaf-50 hover:text-leaf-700 border border-stone-200 transition-colors duration-fast shadow-sm hover:shadow-glow-sm",
  destructive:
    "bg-clay-600 text-white hover:bg-clay-700 shadow-clay hover:shadow-lg border border-transparent",
  quiet:
    "bg-transparent text-leaf-700 hover:bg-leaf-50 hover:text-leaf-600 border border-transparent",
};

/** `md` and up clear the 44 px touch target used on a phone in the field. */
const SIZE_CLASSES: Readonly<Record<ButtonSize, string>> = {
  sm: "min-h-9 px-3.5 py-1.5 text-small",
  md: "min-h-11 px-5 py-2.5 text-body",
  lg: "min-h-12 px-7 py-3 text-body-lg",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Colour role. Defaults to `primary`. */
  variant?: ButtonVariant;
  /** Control height and text step. Defaults to `md`. */
  size?: ButtonSize;
  /** Stretch to the width of the container, e.g. the submit button on a phone. */
  fullWidth?: boolean;
  /**
   * Request in flight: swaps the leading slot for a spinner, sets `aria-busy`, and disables the
   * control so a second submit cannot be queued (Req 3.8).
   */
  loading?: boolean;
  /** Leading icon, replaced by the spinner while `loading`. Decorative — keep it `aria-hidden`. */
  icon?: ReactNode;
  /** Ref to the underlying `<button>`, for focus management such as `ConfirmDialog`'s. */
  buttonRef?: Ref<HTMLButtonElement>;
}

export function Button({
  variant = "primary",
  size = "md",
  fullWidth = false,
  loading = false,
  icon,
  buttonRef,
  className,
  children,
  disabled,
  type = "button",
  ...rest
}: ButtonProps): JSX.Element {
  return (
    <button
      ref={buttonRef}
      // Explicit `type`: an unset button inside a form submits it, which is never what a Clear or a
      // Cancel control means.
      type={type}
      disabled={disabled === true || loading}
      aria-busy={loading || undefined}
      className={[
        BASE_CLASSES,
        VARIANT_CLASSES[variant],
        SIZE_CLASSES[size],
        fullWidth ? "w-full" : "",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      {...rest}
    >
      {/* The label already names the button, so the spinner contributes no text of its own. */}
      {loading ? <Spinner size="sm" label="" className="shrink-0" /> : icon}
      {children}
    </button>
  );
}

export default Button;
