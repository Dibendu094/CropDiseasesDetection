import { useId, type ReactNode } from "react";

import type { FertilizerItem, RecommendationOut } from "../../api/types";
import { Badge, Card } from "../ui";
import { TreatmentTable, hasTreatmentContent, readOptionalText } from "./TreatmentTable";

/**
 * Every field of a `RecommendationOut`, grouped into labelled sections (Req 7.9, 7.10).
 *
 * The order is the design's table, and it is the order a user reads in: what this is, what caused it,
 * how to recognise it, what to do about it organically, then chemically, when to spray, the treatment
 * detail, the fertilizers, how to prevent it next season, the safety notes, and the field tips. Each
 * section is omitted when its field is empty — Req 7.9 asks for the fields that exist to be shown, not
 * for a card that says "none".
 *
 * Four details in here are data-driven rather than aesthetic.
 *
 * **`chemical_spray` is dropped when the plant is healthy.** Not hidden with a class, not rendered
 * empty: the branch never produces the section (Req 7.10). Prevention, fertilizer, and tips guidance
 * stay, because those still apply to a healthy plant.
 *
 * **Prevention is one list built from two fields.** The backend sends `prevention: []` whenever it
 * would duplicate `preventive_measures`, so concatenating the two is correct and each measure renders
 * exactly once. Reading only one of the fields would silently drop the records where they differ.
 *
 * **`farmer_tips` arrives pre-bulleted.** The real data carries a leading "•" on those entries. Left
 * alone, a `list-disc` list renders "• • keep the field weed-free". `stripLeadingBullet` removes the
 * leading marker so the list has exactly one.
 *
 * **Nothing is trusted to be a clean string.** Every value passes through `readOptionalText`, which
 * turns a blank, a `null`, or a wrong-typed entry into nothing at all. The recommendation files are
 * hand-authored across 140 records; a stray `null` in a list must not blank the page.
 *
 * Long strings are `wrap-anywhere` throughout: this data runs to 200+ character sentences and
 * unbroken chemical names, the realistic cause of horizontal scroll at the 360 px floor (Req 12.1).
 */

/** Bullet-ish leaders the hand-authored data uses, plus any whitespace around them. */
const LEADING_BULLET = /^[\s\u2022\u00b7\u2023\u25aa\u25cf\u25e6*\u2013\u2014-]+/u;

/**
 * Strip a leading bullet character from a data string, e.g. `"• Rotate crops"` → `"Rotate crops"`.
 *
 * Applied to `farmer_tips`, where the source data already carries the marker. Exported because a test
 * asserting "no double bullets" needs the same rule the renderer used.
 */
export function stripLeadingBullet(text: string): string {
  return text.replace(LEADING_BULLET, "").trim();
}

/** Readable entries only, trimmed, in source order. */
function cleanList(items: readonly unknown[]): string[] {
  return items.flatMap((item) => {
    const text = readOptionalText(item);
    return text === null ? [] : [text];
  });
}

/** `cleanList` with the data's own bullet markers removed first (`farmer_tips`). */
function cleanTips(items: readonly unknown[]): string[] {
  return cleanList(items).flatMap((item) => {
    const stripped = stripLeadingBullet(item);
    return stripped === "" ? [] : [stripped];
  });
}

/** A fertilizer reduced to the two fields the design renders, both optional. */
interface FertilizerPair {
  name: string | null;
  purpose: string | null;
}

/** Entries with neither a name nor a purpose carry nothing to show. */
function cleanFertilizers(items: readonly FertilizerItem[]): FertilizerPair[] {
  return items.flatMap((item) => {
    const name = readOptionalText(item["name"]);
    const purpose = readOptionalText(item["purpose"]);
    return name === null && purpose === null ? [] : [{ name, purpose }];
  });
}

/** Section surface. `sun` is the accent Req 7.9 gives the safety notes. */
type SectionAccent = "plain" | "sun";

/**
 * One labelled section. The heading is an `h3` — the diagnosis display name above it is the `h2`, so
 * the result reads as one outline rather than a dozen peers — and `aria-labelledby` names the section
 * from that visible heading rather than a duplicated string.
 */
function Section({
  title,
  accent = "plain",
  testId,
  children,
}: {
  title: string;
  accent?: SectionAccent;
  testId: string;
  children: ReactNode;
}): JSX.Element {
  const headingId = useId();

  if (accent === "sun") {
    return (
      <section
        data-testid={testId}
        aria-labelledby={headingId}
        className="rounded-xl bg-sun-100 p-5 sm:p-6"
      >
        <h3 id={headingId} className="text-h3 text-sun-700">
          {title}
        </h3>
        <div className="mt-3">{children}</div>
      </section>
    );
  }

  return (
    <Card as="section" data-testid={testId} aria-labelledby={headingId}>
      <h3 id={headingId} className="text-h3 text-ink-900">
        {title}
      </h3>
      <div className="mt-3">{children}</div>
    </Card>
  );
}

/** A paragraph of body copy. */
function Paragraph({ text }: { text: string }): JSX.Element {
  return <p className="wrap-anywhere text-body text-ink-700">{text}</p>;
}

/**
 * A bullet list. Markers inherit the text colour rather than taking an accent of their own, so the
 * `sun` variant stays inside its own contrast pairing.
 */
function BulletList({ items, tone = "ink" }: { items: readonly string[]; tone?: "ink" | "sun" }): JSX.Element {
  return (
    <ul className={`list-disc space-y-2 pl-5 ${tone === "sun" ? "text-sun-700" : "text-ink-700"}`}>
      {items.map((item, index) => (
        <li key={`${String(index)}-${item.slice(0, 32)}`} className="wrap-anywhere text-body">
          {item}
        </li>
      ))}
    </ul>
  );
}

export interface RecommendationSectionsProps {
  /** The guidance block for the diagnosis, as sent. */
  recommendation: RecommendationOut;
  /**
   * `diagnosis.is_healthy`. Drops the chemical spray section entirely (Req 7.10) and leaves the rest
   * of the guidance in place.
   */
  isHealthy?: boolean;
  /** Extra classes for the wrapper. */
  className?: string;
}

export function RecommendationSections({
  recommendation,
  isHealthy = false,
  className,
}: RecommendationSectionsProps): JSX.Element {
  const description = readOptionalText(recommendation.description);
  const cause = readOptionalText(recommendation.cause);
  const bestTimeToSpray = readOptionalText(recommendation.best_time_to_spray);

  const symptoms = cleanList(recommendation.symptoms);
  const affectedParts = cleanList(recommendation.affected_parts);
  const organicRemedy = cleanList(recommendation.organic_remedy);
  // Never computed for a healthy plant, so the section cannot be produced by accident (Req 7.10).
  const chemicalSpray = isHealthy ? [] : cleanList(recommendation.chemical_spray);
  // One list from two fields: the backend empties `prevention` when it duplicates the other.
  const prevention = cleanList([
    ...recommendation.preventive_measures,
    ...recommendation.prevention,
  ]);
  const safetyTips = cleanList(recommendation.safety_tips);
  const farmerTips = cleanTips(recommendation.farmer_tips);

  const fertilizers = cleanFertilizers(recommendation.fertilizers);
  const hasTreatments = hasTreatmentContent(recommendation.treatment);

  return (
    <div
      data-testid="recommendation-sections"
      className={["space-y-4", className].filter(Boolean).join(" ")}
    >
      {/* 1 — what this is */}
      {description === null ? null : (
        <Section title="What this is" testId="section-description">
          <Paragraph text={description} />
        </Section>
      )}

      {/* 2 — cause */}
      {cause === null ? null : (
        <Section title="Cause" testId="section-cause">
          <Paragraph text={cause} />
        </Section>
      )}

      {/* 3 — symptoms */}
      {symptoms.length === 0 ? null : (
        <Section title="Symptoms" testId="section-symptoms">
          <BulletList items={symptoms} />
        </Section>
      )}

      {/* 4 — affected parts, as chips: each entry is a word or two, not a sentence */}
      {affectedParts.length === 0 ? null : (
        <Section title="Affected parts" testId="section-affected-parts">
          <ul className="flex flex-wrap gap-2">
            {affectedParts.map((part, index) => (
              <li key={`${String(index)}-${part}`}>
                <Badge tone="leaf">{part}</Badge>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {/* 5 — organic remedy */}
      {organicRemedy.length === 0 ? null : (
        <Section title="Organic remedy" testId="section-organic-remedy">
          <BulletList items={organicRemedy} />
        </Section>
      )}

      {/* 6 — chemical spray, absent entirely on a healthy plant (Req 7.10) */}
      {chemicalSpray.length === 0 ? null : (
        <Section title="Chemical spray" testId="section-chemical-spray">
          <BulletList items={chemicalSpray} />
        </Section>
      )}

      {/* 7 — best time to spray, a single callout line */}
      {bestTimeToSpray === null ? null : (
        <Section title="Best time to spray" testId="section-best-time-to-spray">
          <p className="rounded-lg bg-sun-100 px-4 py-3 wrap-anywhere text-body text-sun-700">
            {bestTimeToSpray}
          </p>
        </Section>
      )}

      {/* 8 — treatment detail */}
      {hasTreatments ? (
        <Section title="Recommended treatments" testId="section-treatment">
          <TreatmentTable items={recommendation.treatment} />
        </Section>
      ) : null}

      {/* 9 — fertilizers, as name + purpose pairs */}
      {fertilizers.length === 0 ? null : (
        <Section title="Fertilizers" testId="section-fertilizers">
          <ul className="space-y-3">
            {fertilizers.map((fertilizer, index) => (
              <li key={`${String(index)}-${fertilizer.name ?? "fertilizer"}`}>
                {fertilizer.name === null ? null : (
                  <p className="wrap-anywhere text-body font-semibold text-ink-900">
                    {fertilizer.name}
                  </p>
                )}
                {fertilizer.purpose === null ? null : (
                  <p
                    className={
                      fertilizer.name === null
                        ? "wrap-anywhere text-body text-ink-700"
                        : "mt-0.5 wrap-anywhere text-small text-ink-700"
                    }
                  >
                    {fertilizer.purpose}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </Section>
      )}

      {/* 10 — prevention, rendered once from the merged list */}
      {prevention.length === 0 ? null : (
        <Section title="Prevention" testId="section-prevention">
          <BulletList items={prevention} />
        </Section>
      )}

      {/* 11 — safety, on the warning surface */}
      {safetyTips.length === 0 ? null : (
        <Section title="Safety" accent="sun" testId="section-safety-tips">
          <BulletList items={safetyTips} tone="sun" />
        </Section>
      )}

      {/* 12 — farmer tips, with the data's own bullet markers already stripped */}
      {farmerTips.length === 0 ? null : (
        <Section title="Farmer tips" testId="section-farmer-tips">
          <BulletList items={farmerTips} />
        </Section>
      )}
    </div>
  );
}

export default RecommendationSections;
