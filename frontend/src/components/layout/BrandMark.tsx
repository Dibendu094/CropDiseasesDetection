import { useId, type CSSProperties } from "react";

/**
 * The product mark: a single trifoliate leaf — three rounded lobes on a short stem — drawn inline
 * in `leaf.600` on a `rounded-xl bg-leaf.50` tile (Req 1.6, design "Brand mark").
 *
 * The geometry is the same path set as `public/favicon.svg` (viewBox `0 0 32 32`), so the favicon
 * and the in-app mark are the same drawing. Colour comes from `currentColor` on the tile rather
 * than a hard-coded hex, which keeps the two in sync through the theme token.
 *
 * There is deliberately no machine, device, or circuit motif anywhere in this component; the leaf
 * silhouette is the whole vocabulary (Req 1.6).
 */

/** Tile edge in px. 32 is the navbar size named in the design. */
const DEFAULT_SIZE = 34;

/** Glyph edge as a fraction of the tile edge, leaving an even optical inset. */
const GLYPH_RATIO = 0.72;

/** The three lobes, filled. */
const LOBE_PATHS = [
  "M16 2.6c-4.6 4.4-5.6 9.6-2.1 13.4h4.2c3.5-3.8 2.5-9-2.1-13.4Z",
  "M4.4 8.6c-1 6.2 1.9 10.6 7.1 11.1l2.6-3.3C12.1 11.3 8.8 8.6 4.4 8.6Z",
  "M27.6 8.6c1 6.2-1.9 10.6-7.1 11.1l-2.6-3.3c2-5.1 5.3-7.8 9.7-7.8Z",
] as const;

/** The stem, stroked. */
const STEM_PATH = "M16 16.4v12.2";

export interface BrandMarkProps {
  /** Tile edge length in pixels. Defaults to 34. */
  size?: number;
  /** Extra classes for the tile, e.g. a shadow or a margin. */
  className?: string;
  /**
   * Accessible name for the mark. Leave unset when the mark sits beside the wordmark — the
   * adjacent text already names the link, so a second name would only be read twice.
   */
  label?: string;
}

export function BrandMark({ size = DEFAULT_SIZE, className, label }: BrandMarkProps): JSX.Element {
  const titleId = useId();
  const glyph = Math.round(size * GLYPH_RATIO);
  // Inline so any size works; Tailwind cannot generate arbitrary sizes from a runtime value.
  const tileStyle: CSSProperties = { width: size, height: size };

  return (
    <span
      data-testid="brand-mark"
      className={[
        "inline-flex shrink-0 items-center justify-center rounded-xl shadow-glow-sm",
        "bg-gradient-to-br from-leaf-500 to-leaf-700 text-white",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      style={tileStyle}
    >
      <svg
        // Explicit width/height, so the mark reserves its box before paint (Req 12.1).
        width={glyph}
        height={glyph}
        viewBox="0 0 32 32"
        focusable="false"
        role={label ? "img" : undefined}
        aria-hidden={label ? undefined : true}
        aria-labelledby={label ? titleId : undefined}
      >
        {label ? <title id={titleId}>{label}</title> : null}
        <g fill="currentColor">
          {LOBE_PATHS.map((d) => (
            <path key={d} d={d} />
          ))}
        </g>
        <path
          d={STEM_PATH}
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
        />
      </svg>
    </span>
  );
}

export default BrandMark;
