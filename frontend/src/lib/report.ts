import type {
  CandidateOut,
  FertilizerItem,
  PredictResponse,
  RecommendationOut,
  TreatmentItem,
} from "../api/types";
import { stripLeadingBullet } from "../components/result/RecommendationSections";
import { hasTreatmentContent, readOptionalText } from "../components/result/TreatmentTable";
import { formatConfidence, formatPercent, formatTimestamp, parseTimestamp } from "./format";

/**
 * The downloadable diagnosis report: one self-contained HTML file a grower can keep, mail on, or
 * hand to an extension officer on paper.
 *
 * **Why HTML and not a PDF.** A PDF needs a renderer in the bundle (jsPDF, html2canvas) — hundreds of
 * kilobytes shipped to a phone on a field connection, for a document the browser can already produce:
 * every browser prints, and every print dialog offers "Save as PDF". So the builder emits a document
 * with print rules baked in and lets the platform do the conversion. Nothing here adds a dependency.
 *
 * **Why the file is standalone.** No stylesheet link, no font URL, no script, and the photo travels
 * as a `data:` URL. The report is most useful exactly where the app is not: offline, on someone
 * else's laptop, in an email attachment. A single request to a server that is not reachable would
 * leave it unstyled or unillustrated.
 *
 * **Why every value is escaped.** The strings come from 140 hand-authored recommendation records and
 * from class labels; they are not attacker-controlled today, but they *are* interpolated into markup,
 * and one `<` in a chemical dosage ("<2 ml/L") silently swallows the rest of a section. `escapeHtml`
 * runs on every interpolation, without exception, and the image `src` is additionally checked to be a
 * `data:image/` URL so the one attribute in the document cannot become a script URL.
 *
 * **Why the data rules are imported, not rewritten.** `readOptionalText` is what keeps the literal
 * string "null" off a printed page, `hasTreatmentContent` decides whether a treatment table exists at
 * all, and `stripLeadingBullet` stops the data's own "•" doubling up under a list marker. The screen
 * and the paper have to agree; sharing the functions is what makes that true rather than intended.
 *
 * **Why the input is not a `PredictResponse`.** A history scan detail produces the same document from
 * different-shaped data, so the builder takes a flat {@link ReportInput} and
 * {@link reportInputFromPrediction} adapts the prediction path. The history path builds the same
 * struct, passing a data URL it fetched from the API where the diagnosis path passes one read off the
 * `File` it already holds ({@link fileToDataUrl}).
 */

/** Product name in the report title. Mirrors `APP_NAME`, kept local so this stays a pure module. */
const REPORT_APP_NAME = "Crop Disease Detection";

/** Document title and the `h1` of the report. */
const REPORT_TITLE = "Crop diagnosis report";

/** The uncertainty line, worded for a reader holding the printout with no app beside them. */
export const REPORT_UNCERTAIN_LINE =
  "Low confidence — verify this diagnosis before acting on it. Retake the photo with the affected area filling more of the frame, in even daylight, and scan again.";

/** The closing advisory. Req 7.11: the app supports a decision, it does not make one. */
export const REPORT_ADVISORY =
  "This report is a decision-support aid, not a prescription. Confirm the diagnosis and the treatment with a local agricultural expert before applying any chemical.";

/** The six documented treatment columns, in the order the on-screen table uses them (Req 7.9). */
const TREATMENT_COLUMNS = [
  { key: "name", label: "Name" },
  { key: "purpose", label: "Purpose" },
  { key: "application", label: "Application" },
  { key: "dosage", label: "Dosage" },
  { key: "interval", label: "Interval" },
  { key: "safety", label: "Safety" },
] as const;

/**
 * Everything the report renders, flattened away from any one API response.
 *
 * Percentages arrive already computed (`confidencePercent` is the backend's `confidence_percent`), so
 * the printed figure is the same number the screen showed rather than a second rounding of the raw
 * softmax value.
 */
export interface ReportInput {
  /** `diagnosis.display_name`, e.g. `Tomato Late blight`. */
  displayName: string;
  /** English crop name. */
  crop: string;
  /** Hindi crop name, or `""` when the data files carry none (Req 8.2). */
  cropHindi: string;
  /** Disease name on its own, printed when the plant is not healthy. */
  disease: string;
  /** Drops the chemical spray section, exactly as on screen (Req 7.10). */
  isHealthy: boolean;
  /** The backend's `confidence_percent`, in `[0, 100]`. Not re-derived here. */
  confidencePercent: number;
  /** `true` when the confidence fell below the threshold, adding {@link REPORT_UNCERTAIN_LINE}. */
  isUncertain: boolean;
  /** ISO-8601 UTC scan timestamp. */
  createdAt: string;
  /** The crop the prediction was restricted to, or `null` when every class was in play. */
  cropFilter: string | null;
  /** The top candidates, highest confidence first. Empty for a source that does not keep them. */
  candidates: readonly CandidateOut[];
  /** The guidance block, or `null` for a source that carries none. */
  recommendation: RecommendationOut | null;
  /** `data:image/...` URL of the scanned photo. Omitted when no image is available. */
  imageDataUrl?: string;
}

// --- escaping -----------------------------------------------------------------------

/**
 * Escape a string for interpolation into element content *or* a quoted attribute.
 *
 * Both quote characters are escaped, not just `&<>`, so the same function is safe in either
 * position — an attribute helper that forgot `"` is how a `title` attribute becomes two attributes.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// --- data shaping -------------------------------------------------------------------

/** Readable entries only, trimmed, in source order — the same gate the screen applies. */
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

/** A fertilizer reduced to the two printed fields, both optional. */
function cleanFertilizers(items: readonly FertilizerItem[]): { name: string | null; purpose: string | null }[] {
  return items.flatMap((item) => {
    const name = readOptionalText(item["name"]);
    const purpose = readOptionalText(item["purpose"]);
    return name === null && purpose === null ? [] : [{ name, purpose }];
  });
}

// --- fragments ----------------------------------------------------------------------

/** A section with a heading and pre-built inner markup. Empty bodies never reach here. */
function section(title: string, body: string): string {
  return `<section class="block"><h2>${escapeHtml(title)}</h2>${body}</section>`;
}

/** A section holding one paragraph, or nothing at all when the field is unreadable. */
function textSection(title: string, value: unknown): string {
  const text = readOptionalText(value);
  return text === null ? "" : section(title, `<p>${escapeHtml(text)}</p>`);
}

/** A section holding a bullet list, or nothing at all when no entry is readable. */
function listSection(title: string, items: readonly string[]): string {
  if (items.length === 0) return "";
  const rows = items.map((item) => `<li>${escapeHtml(item)}</li>`).join("");
  return section(title, `<ul>${rows}</ul>`);
}

/** A section holding comma-free chips, used for the short `affected_parts` entries. */
function chipSection(title: string, items: readonly string[]): string {
  if (items.length === 0) return "";
  const chips = items.map((item) => `<span class="chip">${escapeHtml(item)}</span>`).join("");
  return section(title, `<p class="chips">${chips}</p>`);
}

/**
 * The treatment table, with the same two reductions the screen makes: an entry with no readable
 * documented field is not a row, and a column no row fills is not a column.
 */
function treatmentSection(items: readonly TreatmentItem[]): string {
  if (!hasTreatmentContent(items)) return "";

  const rows = items.filter((item) =>
    TREATMENT_COLUMNS.some((column) => readOptionalText(item[column.key]) !== null),
  );
  const columns = TREATMENT_COLUMNS.filter((column) =>
    rows.some((row) => readOptionalText(row[column.key]) !== null),
  );

  const head = columns.map((column) => `<th scope="col">${escapeHtml(column.label)}</th>`).join("");
  const body = rows
    .map((row) => {
      const cells = columns
        .map((column) => `<td>${escapeHtml(readOptionalText(row[column.key]) ?? "")}</td>`)
        .join("");
      return `<tr>${cells}</tr>`;
    })
    .join("");

  return section(
    "Recommended treatments",
    `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`,
  );
}

/** Fertilizers as name + purpose pairs, each entry keeping whichever half it has. */
function fertilizerSection(items: readonly FertilizerItem[]): string {
  const pairs = cleanFertilizers(items);
  if (pairs.length === 0) return "";

  const rows = pairs
    .map((pair) => {
      const name = pair.name === null ? "" : `<strong>${escapeHtml(pair.name)}</strong>`;
      const purpose =
        pair.purpose === null ? "" : `<span class="purpose">${escapeHtml(pair.purpose)}</span>`;
      return `<li>${name}${purpose}</li>`;
    })
    .join("");

  return section("Fertilizers", `<ul class="pairs">${rows}</ul>`);
}

/** The top candidates, highest confidence first (Req 5.5), or nothing when none were kept. */
function candidateSection(candidates: readonly CandidateOut[]): string {
  if (candidates.length === 0) return "";

  const rows = candidates
    .map((candidate) => {
      // Same fallback as the screen: a blank display name reads as the raw label, not as a gap.
      const name =
        candidate.display_name.trim() === "" ? candidate.label : candidate.display_name;
      // `confidence` is a bare softmax fraction on a candidate, so it is converted, not re-rounded
      // from a percentage the backend already computed.
      return `<li><span>${escapeHtml(name)}</span><span class="pct">${escapeHtml(
        formatConfidence(candidate.confidence),
      )}</span></li>`;
    })
    .join("");

  return section("Top candidates", `<ol class="candidates">${rows}</ol>`);
}

/**
 * Every recommendation section, in the on-screen order and under the on-screen headings.
 *
 * `chemical_spray` is not merely hidden for a healthy plant: the list is never computed, so the
 * section cannot be produced by accident (Req 7.10). Prevention is one list built from two fields,
 * because the backend empties `prevention` when it would duplicate `preventive_measures`.
 */
function recommendationSections(recommendation: RecommendationOut, isHealthy: boolean): string {
  const chemicalSpray = isHealthy ? [] : cleanList(recommendation.chemical_spray);
  const prevention = cleanList([
    ...recommendation.preventive_measures,
    ...recommendation.prevention,
  ]);

  return [
    textSection("What this is", recommendation.description),
    textSection("Cause", recommendation.cause),
    listSection("Symptoms", cleanList(recommendation.symptoms)),
    chipSection("Affected parts", cleanList(recommendation.affected_parts)),
    listSection("Organic remedy", cleanList(recommendation.organic_remedy)),
    listSection("Chemical spray", chemicalSpray),
    textSection("Best time to spray", recommendation.best_time_to_spray),
    treatmentSection(recommendation.treatment),
    fertilizerSection(recommendation.fertilizers),
    listSection("Prevention", prevention),
    listSection("Safety", cleanList(recommendation.safety_tips)),
    listSection("Farmer tips", cleanTips(recommendation.farmer_tips)),
  ].join("");
}

/**
 * The photo, embedded.
 *
 * Only a `data:image/` URL is accepted. The `src` is the single attribute in the document built from
 * input, and an `http:` URL would make the "no external requests" promise false while a `javascript:`
 * URL would make it dangerous.
 */
function photoSection(imageDataUrl: string | undefined, altSubject: string): string {
  if (imageDataUrl === undefined || !/^data:image\//i.test(imageDataUrl)) return "";
  const alt = altSubject === "" ? "Scanned leaf photo" : `Scanned leaf photo: ${altSubject}`;
  return `<section class="block photo"><img src="${escapeHtml(imageDataUrl)}" alt="${escapeHtml(
    alt,
  )}" /></section>`;
}

/** Print rules and a plain document style. Inline, because the file has to stand on its own. */
const REPORT_STYLES = `
  @page { size: A4; margin: 16mm; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 24px;
    background: #ffffff;
    color: #1c1917;
    font: 14px/1.55 "Helvetica Neue", Helvetica, Arial, sans-serif;
  }
  main { max-width: 760px; margin: 0 auto; }
  .app { margin: 0; font-size: 12px; letter-spacing: 0.08em; text-transform: uppercase; color: #57534e; }
  h1 { margin: 4px 0 0; font-size: 24px; }
  h2 { margin: 0 0 6px; font-size: 16px; }
  h3 { margin: 0; font-size: 20px; }
  p { margin: 0 0 8px; }
  p:last-child { margin-bottom: 0; }
  ul, ol { margin: 0; padding-left: 20px; }
  li { margin: 0 0 6px; }
  li:last-child { margin-bottom: 0; }
  .head { padding-bottom: 12px; border-bottom: 2px solid #1c1917; }
  .block, .summary {
    margin-top: 16px;
    padding: 12px 14px;
    border: 1px solid #e7e5e4;
    border-radius: 8px;
    page-break-inside: avoid;
    break-inside: avoid;
  }
  .summary .crop { font-size: 15px; }
  .hindi { color: #57534e; }
  .pct, .meta { color: #57534e; }
  .meta { font-size: 12px; }
  .figure { font-size: 15px; font-weight: 700; }
  .warn { padding: 8px 10px; border-left: 4px solid #b45309; background: #fef3c7; color: #78350f; }
  .chips { display: block; }
  .chip { display: inline-block; margin: 0 6px 6px 0; padding: 2px 8px; border: 1px solid #d6d3d1; border-radius: 999px; font-size: 12px; }
  .candidates li { display: flex; justify-content: space-between; gap: 12px; }
  .pairs { list-style: none; padding-left: 0; }
  .pairs .purpose { display: block; font-size: 13px; color: #44403c; }
  table { width: 100%; border-collapse: collapse; }
  th, td { padding: 6px 8px; border: 1px solid #e7e5e4; text-align: left; vertical-align: top; font-size: 13px; word-break: break-word; }
  th { background: #f5f5f4; }
  .photo img { display: block; width: 100%; max-width: 320px; height: auto; border-radius: 8px; }
  footer { margin-top: 20px; padding-top: 12px; border-top: 1px solid #e7e5e4; font-size: 12px; color: #44403c; page-break-inside: avoid; break-inside: avoid; }
  @media print {
    body { padding: 0; font-size: 12px; }
    .block, .summary { border-color: #d6d3d1; }
    .photo img { max-width: 240px; }
    a[href]:after { content: ""; }
  }
`;

/**
 * Build the whole report as one HTML document string.
 *
 * Pure: no DOM, no clock, no network. Everything it prints comes from `input`, which is what lets a
 * test assert the document rather than a screenshot of it.
 */
export function buildReportHtml(input: ReportInput): string {
  const displayName = readOptionalText(input.displayName) ?? "Unnamed diagnosis";
  const crop = readOptionalText(input.crop);
  const cropHindi = readOptionalText(input.cropHindi);
  const disease = readOptionalText(input.disease);
  const cropFilter = readOptionalText(input.cropFilter);

  const cropLine =
    crop === null
      ? ""
      : `<p class="crop">Crop: ${escapeHtml(crop)}${
          cropHindi === null ? "" : ` <span class="hindi" lang="hi">${escapeHtml(cropHindi)}</span>`
        }</p>`;

  const statusLine = input.isHealthy
    ? `<p>Status: Healthy plant</p>`
    : disease === null
      ? ""
      : `<p>Disease: ${escapeHtml(disease)}</p>`;

  const body = [
    `<header class="head"><p class="app">${escapeHtml(REPORT_APP_NAME)}</p><h1>${escapeHtml(
      REPORT_TITLE,
    )}</h1></header>`,
    `<section class="summary">`,
    `<h3>${escapeHtml(displayName)}</h3>`,
    cropLine,
    statusLine,
    `<p class="figure">Confidence: ${escapeHtml(formatPercent(input.confidencePercent))}</p>`,
    input.isUncertain ? `<p class="warn">${escapeHtml(REPORT_UNCERTAIN_LINE)}</p>` : "",
    `<p class="meta">Scanned: ${escapeHtml(formatTimestamp(input.createdAt))}</p>`,
    cropFilter === null
      ? ""
      : `<p class="meta">Restricted to crop: ${escapeHtml(cropFilter)}</p>`,
    `</section>`,
    photoSection(input.imageDataUrl, displayName),
    candidateSection(input.candidates),
    input.recommendation === null
      ? ""
      : recommendationSections(input.recommendation, input.isHealthy),
    `<footer>${escapeHtml(REPORT_ADVISORY)}</footer>`,
  ].join("");

  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    `<title>${escapeHtml(`${REPORT_TITLE} — ${displayName}`)}</title>`,
    `<style>${REPORT_STYLES}</style>`,
    "</head>",
    `<body><main>${body}</main></body>`,
    "</html>",
  ].join("\n");
}

// --- filename -----------------------------------------------------------------------

/** `Tomato Late blight` → `tomato-late-blight`; anything unusable collapses to `""`. */
function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * A safe download filename, e.g. `crop-diagnosis-tomato-late-blight-2026-08-30.html`.
 *
 * Lowercase ASCII, hyphens, and a date — nothing a Windows, macOS, or Android file system objects
 * to, and no reliance on the browser sanitising a `download` attribute for us. A Devanagari or
 * accented display name reduces to the date alone rather than to an empty name.
 */
export function reportFilename(input: ReportInput): string {
  const name = slugify(readOptionalText(input.displayName) ?? "");
  const date = parseTimestamp(input.createdAt);
  const day = date === null ? "" : date.toISOString().slice(0, 10);

  const parts = ["crop-diagnosis", name, day].filter((part) => part !== "");
  return `${parts.join("-")}.html`;
}

// --- download -----------------------------------------------------------------------

/**
 * Hand the built document to the browser as a download.
 *
 * A Blob plus a synthetic `<a download>` click is the only approach that works without a server
 * round-trip and without a popup blocker in the way. The object URL is revoked immediately after the
 * click, since the browser has already taken its own reference to the blob by then.
 *
 * The `URL.createObjectURL` guard is not defensive noise: jsdom does not implement it, so a component
 * test that clicks the download button would otherwise throw inside the handler rather than assert
 * anything. Missing support means "no download", not "crash".
 *
 * @returns `true` when a download was triggered, `false` when the environment cannot make one
 */
export function downloadReport(html: string, filename: string): boolean {
  if (typeof URL === "undefined" || typeof URL.createObjectURL !== "function") return false;

  const url = URL.createObjectURL(new Blob([html], { type: "text/html;charset=utf-8" }));
  try {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.rel = "noopener";
    anchor.style.display = "none";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    return true;
  } finally {
    if (typeof URL.revokeObjectURL === "function") URL.revokeObjectURL(url);
  }
}

// --- image ---------------------------------------------------------------------------

/**
 * Read a picked `File` into a `data:` URL so the report can embed the photo.
 *
 * `FileReader` rather than `URL.createObjectURL`: an object URL only lives as long as the document
 * that made it, and the whole point of the report is to be readable after that document is gone.
 *
 * The diagnosis page has the original `File` and uses this. The history page has no `File` — it
 * fetches the stored image through the API and passes the resulting data URL straight into
 * {@link ReportInput.imageDataUrl}.
 */
export function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => {
      reject(new Error("The photo could not be read."));
    };
    reader.onload = () => {
      const result = reader.result;
      if (typeof result === "string") resolve(result);
      else reject(new Error("The photo could not be read."));
    };
    reader.readAsDataURL(file);
  });
}

// --- adapters ------------------------------------------------------------------------

/**
 * Flatten a `PredictResponse` into a {@link ReportInput}.
 *
 * The percentage is taken from `diagnosis.confidence_percent`, the field the backend computed, so the
 * printed number matches the meter on screen (Req 11.7).
 */
export function reportInputFromPrediction(
  result: PredictResponse,
  imageDataUrl?: string,
): ReportInput {
  const { diagnosis } = result;

  return {
    displayName: diagnosis.display_name,
    crop: diagnosis.crop,
    cropHindi: diagnosis.crop_hindi,
    disease: diagnosis.disease,
    isHealthy: diagnosis.is_healthy,
    confidencePercent: diagnosis.confidence_percent,
    isUncertain: diagnosis.is_uncertain,
    createdAt: result.created_at,
    cropFilter: result.meta.crop_filter,
    candidates: result.candidates,
    recommendation: result.recommendation,
    ...(imageDataUrl === undefined ? {} : { imageDataUrl }),
  };
}
