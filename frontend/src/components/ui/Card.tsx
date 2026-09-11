import type { HTMLAttributes, ReactNode } from "react";

/**
 * The standard surface: a white/gradient panel with a subtle border, `rounded-2xl`, `shadow-md`
 * at rest. Result sections, history entries, and the upload panel all sit on one of these, so the
 * radius and shadow scale stay consistent (the design allows nothing deeper than `shadow-xl`).
 *
 * `as` exists because the right element depends on the context — a history entry is an `<li>`, a
 * recommendation group is a `<section>` — and swapping the tag must not mean re-deriving the
 * surface styling.
 */

export type CardElement = "div" | "section" | "article" | "aside" | "li";

export type CardPadding = "none" | "sm" | "md";

const PADDING_CLASSES: Readonly<Record<CardPadding, string>> = {
  none: "",
  sm: "p-4",
  // The design's card rhythm: p-5 on mobile, p-6 from 640 px up.
  md: "p-5 sm:p-6",
};

export interface CardProps extends HTMLAttributes<HTMLElement> {
  /** Element to render. Defaults to `div`. */
  as?: CardElement;
  /** Internal padding. Defaults to `md`; use `none` when the card holds an edge-to-edge image. */
  padding?: CardPadding;
  /**
   * Lift and deepen the shadow on hover. Only for a card that is itself a link or a button target —
   * a static panel that moves under the pointer is noise. The transform is neutralised by the
   * global reduced-motion block (Req 11.6).
   */
  interactive?: boolean;
  /** Use the premium gradient surface instead of plain white. */
  gradient?: boolean;
  children?: ReactNode;
}

export function Card({
  as = "div",
  padding = "md",
  interactive = false,
  gradient = false,
  className,
  children,
  ...rest
}: CardProps): JSX.Element {
  const Tag = as;

  return (
    <Tag
      className={[
        "rounded-xl rounded-2xl border shadow-sm",
        gradient ? "card-premium" : "border-stone-200 bg-white",
        PADDING_CLASSES[padding],
        interactive ? "hover-lift cursor-pointer hover:border-leaf-200 hover:shadow-md transition-all duration-200" : "",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      {...rest}
    >
      {children}
    </Tag>
  );
}

export default Card;
