import type { ReactNode } from "react";

/**
 * A heading with an optional supporting line and an optional trailing control.
 *
 * `level` is a separate prop from the visual step on purpose: the recommendation sections are `h3`
 * inside the result card, the page titles are `h1`, and the outline has to stay correct even when a
 * designer wants the same size in two places. Passing `level` sets the tag; `size` overrides the
 * type step independently, and defaults to the step that matches the level.
 *
 * `id` is worth setting whenever something references the heading — a `<section aria-labelledby>`,
 * or `ConfirmDialog`'s own title — so the accessible name comes from the visible text rather than a
 * duplicated string.
 *
 * Enhanced with an optional gradient accent bar under h1 headings and better description styling.
 */

export type HeadingLevel = 1 | 2 | 3;

const SIZE_CLASSES: Readonly<Record<HeadingLevel, string>> = {
  1: "text-h1",
  2: "text-h2",
  3: "text-h3",
};

export interface SectionHeadingProps {
  /** Heading rank, `1`–`3`, mapped to `h1`–`h3`. Defaults to `2`. */
  level?: HeadingLevel;
  /** Type step, when it should differ from the rank. Defaults to the step matching `level`. */
  size?: HeadingLevel;
  /** `id` on the heading element, for `aria-labelledby` references. */
  id?: string;
  /** The heading text. */
  children: ReactNode;
  /** One supporting line below the heading, set in muted `ink.500` (5.35:1 on white). */
  description?: ReactNode;
  /** Trailing control aligned with the heading, e.g. a "Clear all" button. */
  actions?: ReactNode;
  /** Extra classes for the wrapper. */
  className?: string;
}

export function SectionHeading({
  level = 2,
  size,
  id,
  children,
  description,
  actions,
  className,
}: SectionHeadingProps): JSX.Element {
  const Tag = `h${level}` as "h1" | "h2" | "h3";

  return (
    <div
      className={["flex items-start justify-between gap-4", className].filter(Boolean).join(" ")}
    >
      <div className="min-w-0">
        <Tag id={id} className={`${SIZE_CLASSES[size ?? level]} wrap-anywhere text-ink-900`}>
          {children}
        </Tag>
        {level === 1 ? (
          // Gradient accent bar beneath h1 page titles for premium feel
          <span
            aria-hidden="true"
            className="mt-2 block h-1 w-12 rounded-full bg-leaf-gradient"
          />
        ) : null}
        {description === undefined || description === null || description === "" ? null : (
          <p className={`${level === 1 ? "mt-3" : "mt-1.5"} wrap-anywhere text-body text-ink-500`}>
            {description}
          </p>
        )}
      </div>
      {actions ? <div className="shrink-0">{actions}</div> : null}
    </div>
  );
}

export default SectionHeading;
