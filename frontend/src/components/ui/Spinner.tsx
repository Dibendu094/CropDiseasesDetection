/**
 * The single busy indicator: a spinning ring with a gradient arc.
 *
 * Two accessibility decisions worth stating, because they look like omissions otherwise.
 *
 * First, the ring itself is `aria-hidden` — it carries no information a screen reader can use. The
 * text does. When `label` is non-empty it renders as a real text node, visually hidden unless
 * `showLabel` is set, so a user exploring the page still finds "Analysing photo…" rather than a
 * silent gap.
 *
 * Second, the spinner is **not** a live region by default. The design allows exactly one
 * `aria-live` node per page (`LiveRegion`, Req 12.6); a spinner that also announced itself would
 * make every pending state speak twice. Pass `announce` for the rare standalone case where no
 * page-level live region is present.
 *
 * The global reduced-motion block in `index.css` collapses the rotation for anyone who asked for
 * less motion (Req 11.6) — nothing to handle here.
 */

export type SpinnerSize = "sm" | "md" | "lg";

/** Ring diameter and stroke per size. `sm` is the size used inside a button. */
const SIZE_CLASSES: Readonly<Record<SpinnerSize, string>> = {
  sm: "h-4 w-4 border-2",
  md: "h-6 w-6 border-[2.5px]",
  lg: "h-10 w-10 border-[3px]",
};

export interface SpinnerProps {
  /** Ring diameter. Defaults to `md`. */
  size?: SpinnerSize;
  /**
   * Text describing what is pending, e.g. `"Analysing photo…"`. Pass `""` to render the ring with
   * no text at all — correct inside a button that already has its own label.
   */
  label?: string;
  /** Render `label` as visible text beside the ring rather than only to assistive technology. */
  showLabel?: boolean;
  /**
   * Expose the spinner as a polite live region. Leave unset when the page already has a
   * `LiveRegion`, which is the normal case (Req 12.6).
   */
  announce?: boolean;
  /** Extra classes for the wrapper. */
  className?: string;
}

export function Spinner({
  size = "md",
  label = "Loading…",
  showLabel = false,
  announce = false,
  className,
}: SpinnerProps): JSX.Element {
  const hasLabel = label.trim() !== "";

  return (
    <span
      data-testid="spinner"
      role={announce ? "status" : undefined}
      aria-live={announce ? "polite" : undefined}
      aria-atomic={announce ? true : undefined}
      className={["inline-flex items-center gap-3", className].filter(Boolean).join(" ")}
    >
      {/* Gradient ring: leaf-100 track with a leaf-500→leaf-300 leading gradient arc via CSS trick */}
      <span
        aria-hidden={true}
        data-testid="spinner-ring"
        className={`${SIZE_CLASSES[size]} shrink-0 animate-spin rounded-full border-leaf-100 border-t-leaf-500 border-r-leaf-300`}
      />
      {hasLabel ? (
        <span className={showLabel ? "text-small font-medium text-ink-500" : "sr-only"}>{label}</span>
      ) : null}
    </span>
  );
}

export default Spinner;
