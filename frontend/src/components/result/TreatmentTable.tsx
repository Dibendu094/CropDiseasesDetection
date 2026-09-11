import type { TreatmentItem } from "../../api/types";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { Card } from "../ui";

/**
 * The `treatment` list: what to apply, why, how, how much, how often, and what to watch out for
 * (Req 7.9, 12.1).
 *
 * **One layout at a time, chosen in JS.** A six-column table is unreadable at 360 px, so below
 * 640 px each entry becomes a card of label/value pairs. The choice goes through `useMediaQuery`
 * rather than a `hidden sm:table` / `sm:hidden` pair, because the pair leaves both copies in the DOM
 * and a screen reader then reads every dosage twice. Same reasoning as the `Navbar`'s link row.
 *
 * **Empty cells are omitted, not filled.** Every field is `string | null | undefined` and the type
 * carries an index signature, because the recommendation files are hand-authored and the backend
 * allows extra keys. `readOptionalText` is the single gate: a non-blank string (or a finite number)
 * becomes text, and anything else — `null`, `undefined`, `""`, a nested object — becomes nothing.
 * That is what keeps the literal string "null" off a farmer's screen.
 *
 * A column absent from every row is dropped entirely rather than rendered as a strip of blanks, which
 * matters most at the narrow end of the table where six headings compete for 640 px.
 *
 * **Nothing overflows.** Cells are `wrap-anywhere`: the real data carries unbroken chemical names
 * ("chlorantraniliprole") that would otherwise force a horizontal scrollbar (Req 12.1).
 *
 * Returns `null` when no entry has a single readable field, so a caller can hand it
 * `recommendation.treatment` unconditionally.
 */

/** The breakpoint at which the real table replaces the stacked cards: the `sm` step, 640 px. */
export const TREATMENT_TABLE_QUERY = "(min-width: 640px)";

/**
 * The six documented columns, in the order Req 7.9 lists them. Extra keys the data may carry are not
 * promoted to columns: a hand-authored typo would otherwise widen the table for every record.
 */
const COLUMNS = [
  { key: "name", label: "Name" },
  { key: "purpose", label: "Purpose" },
  { key: "application", label: "Application" },
  { key: "dosage", label: "Dosage" },
  { key: "interval", label: "Interval" },
  { key: "safety", label: "Safety" },
] as const;

/** One rendered column of the treatment table. */
export type TreatmentColumn = (typeof COLUMNS)[number];

/**
 * The one gate between the data and the screen: a displayable string, or `null`.
 *
 * Takes `unknown` because that is what an index signature yields, and because these values come from
 * hand-authored JSON where a field can be missing, blank, or the wrong type. Finite numbers are
 * accepted — a dosage authored as `2` is still a dosage — and everything else reads as absent.
 *
 * Shared with `RecommendationSections`, which needs the same rule for `fertilizers` and for every
 * list entry.
 */
export function readOptionalText(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed === "" ? null : trimmed;
  }
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

/** `true` when at least one entry has at least one readable documented field. */
export function hasTreatmentContent(items: readonly TreatmentItem[]): boolean {
  return items.some((item) => COLUMNS.some((column) => readOptionalText(item[column.key]) !== null));
}

export interface TreatmentTableProps {
  /** `recommendation.treatment`, as sent. Entries with nothing readable are dropped. */
  items: readonly TreatmentItem[];
  /** Accessible name for the table, rendered as an `sr-only` caption. */
  caption?: string;
  /** Extra classes for the wrapper. */
  className?: string;
}

export function TreatmentTable({
  items,
  caption = "Recommended treatments",
  className,
}: TreatmentTableProps): JSX.Element | null {
  // Before the early return: a hook cannot be skipped on a render that happens to have no rows.
  const wide = useMediaQuery(TREATMENT_TABLE_QUERY);

  const rows = items.filter((item) =>
    COLUMNS.some((column) => readOptionalText(item[column.key]) !== null),
  );
  if (rows.length === 0) return null;

  // Only the columns the data actually fills, so six headings do not fight over a 640 px row.
  const columns = COLUMNS.filter((column) =>
    rows.some((row) => readOptionalText(row[column.key]) !== null),
  );

  /** Names repeat across records, so the index is part of the key. */
  const rowKey = (row: TreatmentItem, index: number): string =>
    `${readOptionalText(row["name"]) ?? "treatment"}-${String(index)}`;

  if (!wide) {
    return (
      <ul
        data-testid="treatment-cards"
        className={["space-y-3", className].filter(Boolean).join(" ")}
      >
        {rows.map((row, index) => {
          const name = readOptionalText(row["name"]);
          const details = columns.flatMap((column) => {
            if (column.key === "name") return [];
            const value = readOptionalText(row[column.key]);
            return value === null ? [] : [{ label: column.label, value }];
          });

          return (
            <Card as="li" padding="sm" key={rowKey(row, index)}>
              {name === null ? null : (
                <h4 className="wrap-anywhere text-body font-semibold text-ink-900">{name}</h4>
              )}
              {details.length === 0 ? null : (
                <dl className={name === null ? "space-y-2" : "mt-2 space-y-2"}>
                  {details.map((detail) => (
                    <div key={detail.label}>
                      <dt className="text-caption font-semibold uppercase tracking-wide text-ink-500">
                        {detail.label}
                      </dt>
                      <dd className="mt-0.5 wrap-anywhere text-small text-ink-700">
                        {detail.value}
                      </dd>
                    </div>
                  ))}
                </dl>
              )}
            </Card>
          );
        })}
      </ul>
    );
  }

  return (
    <table
      data-testid="treatment-table"
      className={["w-full border-collapse text-left", className].filter(Boolean).join(" ")}
    >
      {/* The section heading above is visible; the caption is what names the table to a screen
          reader navigating tables directly. */}
      <caption className="sr-only">{caption}</caption>
      <thead>
        <tr className="bg-stone-100">
          {columns.map((column) => (
            <th
              key={column.key}
              scope="col"
              className="px-3 py-2 font-heading text-caption font-semibold uppercase tracking-wide text-ink-700"
            >
              {column.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, index) => (
          <tr key={rowKey(row, index)} className="border-t border-stone-200">
            {columns.map((column) => {
              const value = readOptionalText(row[column.key]);
              // The name column is the row's header: it is what identifies the other five cells.
              if (column.key === "name") {
                return (
                  <th
                    key={column.key}
                    scope="row"
                    className="px-3 py-3 align-top wrap-anywhere text-small font-semibold text-ink-900"
                  >
                    {value}
                  </th>
                );
              }
              return (
                <td key={column.key} className="px-3 py-3 align-top wrap-anywhere text-small text-ink-700">
                  {value}
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default TreatmentTable;
