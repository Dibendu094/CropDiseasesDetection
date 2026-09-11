/**
 * Display formatters shared by the result card, the history card, and the live regions.
 *
 * Three concerns: the one-decimal confidence percentage (Req 11.7), the creation timestamp
 * (Req 9.7), and the human label for a backend model id.
 *
 * Every function here is total: no input throws. Out-of-range numbers are clamped, non-finite
 * numbers read as zero, and an unparseable timestamp yields a stated placeholder rather than
 * `Invalid Date`. That keeps a malformed field from taking a page down with it.
 */

import { BYTES_PER_MB } from "./constants";

// --- numbers ------------------------------------------------------------------------

/**
 * Round to one decimal place using round-half-to-even.
 *
 * The tie rule matches Python's `round(x, 1)`, which is how the backend computes
 * `confidence_percent`. Ties are rare — they need a value whose double is exactly `x.x5`, such as
 * `0.25` — but where they occur both sides now land on the same digit.
 */
export function roundToOneDecimal(value: number): number {
  if (!Number.isFinite(value)) return 0;

  const scaled = value * 10;
  const lower = Math.floor(scaled);
  const remainder = scaled - lower;

  let rounded: number;
  if (remainder > 0.5) rounded = lower + 1;
  else if (remainder < 0.5) rounded = lower;
  else rounded = lower % 2 === 0 ? lower : lower + 1;

  return rounded / 10;
}

/**
 * Convert a raw softmax confidence in `[0, 1]` to a percentage rounded to one decimal.
 *
 * Use this only for values that arrive as a bare fraction, such as `CandidateOut.confidence`.
 * For a diagnosis or a history item, pass the backend's `confidence_percent` to
 * {@link formatPercent} instead — that field is authoritative and must not be re-derived, which is
 * what keeps the result card and the history list showing the same number (Property 25).
 *
 * Values outside `[0, 1]` are clamped; non-finite values read as `0`.
 */
export function confidenceToPercent(confidence: number): number {
  if (!Number.isFinite(confidence)) return 0;
  const clamped = Math.min(1, Math.max(0, confidence));
  return roundToOneDecimal(clamped * 100);
}

/**
 * Render an already-computed percentage with exactly one decimal, e.g. `94.3%`.
 *
 * Input is a percentage in `[0, 100]`, clamped if it falls outside; non-finite values read as `0`.
 * Always one decimal, so `100` renders `100.0%` and the column does not jitter in `tabular-nums`.
 */
export function formatPercent(percent: number): string {
  const clamped = Math.min(100, Math.max(0, Number.isFinite(percent) ? percent : 0));
  return `${roundToOneDecimal(clamped).toFixed(1)}%`;
}

/**
 * Render a raw confidence fraction in `[0, 1]` as a one-decimal percentage, e.g. `0.943` → `94.3%`.
 *
 * Convenience over {@link confidenceToPercent} for candidates and anything else carrying only the
 * bare fraction.
 */
export function formatConfidence(confidence: number): string {
  return formatPercent(confidenceToPercent(confidence));
}

/**
 * Render a byte count as megabytes with one decimal, e.g. `14.2` for 14,900,000 bytes.
 *
 * Used by `validateImage` to state the size of the file the user actually picked. Negative and
 * non-finite inputs read as `0`.
 */
export function formatMegabytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0.0";
  return roundToOneDecimal(bytes / BYTES_PER_MB).toFixed(1);
}

// --- timestamps ---------------------------------------------------------------------

/** Shown in place of a timestamp that cannot be parsed, so alt text is never empty (Req 12.5). */
export const UNKNOWN_TIMESTAMP = "Unknown date";

export interface TimestampOptions {
  /**
   * IANA time zone to render in, e.g. `"UTC"`. Defaults to the viewer's local zone, which is what
   * a user in the field expects. Tests pin it to get a stable string.
   */
  readonly timeZone?: string;
}

/**
 * Format an ISO-8601 UTC timestamp for display, e.g. `2026-08-30T15:04:05.123Z` → `30 Aug 2026,
 * 15:04` in the viewer's time zone.
 *
 * Day-month-year with a short month name and a 24-hour clock: unambiguous to read, and never the
 * `MM/DD` / `DD/MM` coin flip. Returns {@link UNKNOWN_TIMESTAMP} for a value that is not a date.
 */
export function formatTimestamp(iso: string, options: TimestampOptions = {}): string {
  const date = parseTimestamp(iso);
  if (!date) return UNKNOWN_TIMESTAMP;

  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    ...(options.timeZone === undefined ? {} : { timeZone: options.timeZone }),
  }).format(date);
}

/**
 * Parse an ISO-8601 timestamp, returning `null` rather than an `Invalid Date`.
 *
 * Exported so a caller that needs the `Date` itself — sorting, a `<time dateTime>` attribute —
 * shares one definition of "parseable".
 */
export function parseTimestamp(iso: string): Date | null {
  if (typeof iso !== "string" || iso.trim() === "") return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

// --- model labels -------------------------------------------------------------------

/**
 * Human labels for the backend model ids, used by the model badge on the result card and the
 * history card. Keys are the `ModelSpec.id` values from the design's model table.
 */
const MODEL_LABELS: Readonly<Record<string, string>> = {
  vit_b16: "ViT-B/16",
  efficientnet_b3: "EfficientNet-B3",
};

/** Shown when a model id is missing entirely, so the badge is never blank. */
export const UNKNOWN_MODEL_LABEL = "Unknown model";

/**
 * Turn a backend model id into a display label: `vit_b16` → `ViT-B/16`,
 * `efficientnet_b3` → `EfficientNet-B3`.
 *
 * An id added on the backend before this table is updated is humanised rather than dropped —
 * separators become spaces and each word is capitalised — so the badge degrades to something
 * readable instead of empty.
 */
export function formatModelLabel(modelId: string): string {
  if (typeof modelId !== "string") return UNKNOWN_MODEL_LABEL;

  const id = modelId.trim();
  if (id === "") return UNKNOWN_MODEL_LABEL;

  const known = MODEL_LABELS[id];
  if (known !== undefined) return known;

  return humanise(id);
}

/** `some_new_model` → `Some New Model`. Collapses runs of `_`, `-`, and whitespace. */
function humanise(id: string): string {
  const words = id
    .split(/[\s_-]+/)
    .filter((word) => word !== "")
    .map((word) => {
      const first = word.charAt(0);
      return `${first.toUpperCase()}${word.slice(1)}`;
    });

  return words.length === 0 ? UNKNOWN_MODEL_LABEL : words.join(" ");
}
