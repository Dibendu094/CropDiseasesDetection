import { describe, expect, it, vi } from "vitest";

import type { RecommendationOut } from "../api/types";
import {
  REPORT_ADVISORY,
  buildReportHtml,
  downloadReport,
  escapeHtml,
  reportFilename,
  type ReportInput,
} from "./report";

/**
 * The report is a document a farmer may print and act on, so the tests here are about the four ways it
 * could mislead rather than about its markup: unescaped data breaking a section, a `null` printing as
 * the word "null", chemical spray advice appearing for a healthy plant, and the data's own bullets
 * doubling under a list marker. The filename and the download trigger are covered because both have to
 * survive a browser that offers no Blob URLs.
 */

function recommendation(overrides: Partial<RecommendationOut> = {}): RecommendationOut {
  return {
    source_key: "Tomato___Late_blight",
    resolution_stage: "exact",
    is_placeholder: false,
    description: "A water mould that spreads fast in cool, wet weather.",
    cause: "Phytophthora infestans",
    best_time_to_spray: "Early morning",
    symptoms: ["Dark greasy patches on leaves"],
    affected_parts: ["Leaves", "Stems"],
    organic_remedy: ["Remove and burn infected leaves"],
    chemical_spray: ["Mancozeb 75% WP"],
    preventive_measures: ["Rotate crops"],
    prevention: [],
    safety_tips: ["Wear gloves"],
    farmer_tips: ["• Scout the field twice a week"],
    fertilizers: [{ name: "NPK 19:19:19", purpose: "General vigour" }],
    treatment: [{ name: "Mancozeb", dosage: "2 g/L", purpose: null }],
    ...overrides,
  };
}

function input(overrides: Partial<ReportInput> = {}): ReportInput {
  return {
    displayName: "Tomato Late blight",
    crop: "Tomato",
    cropHindi: "टमाटर",
    disease: "Late blight",
    isHealthy: false,
    confidencePercent: 94.3,
    isUncertain: false,
    createdAt: "2026-08-30T15:04:05.123Z",
    cropFilter: null,
    candidates: [{ label: "Tomato___Late_blight", display_name: "Tomato Late blight", confidence: 0.943 }],
    recommendation: recommendation(),
    ...overrides,
  };
}

describe("escapeHtml", () => {
  it("escapes both quote characters as well as the angle brackets", () => {
    expect(escapeHtml(`<a href="x">&'`)).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&#39;");
  });
});

describe("buildReportHtml", () => {
  it("produces a standalone document with no external requests or scripts", () => {
    const html = buildReportHtml(input());

    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("<style>");
    expect(html).toContain("@media print");
    expect(html).not.toContain("<script");
    expect(html).not.toContain('href="http');
    expect(html).not.toContain('src="http');
  });

  it("prints the diagnosis, the crop pair, the backend's percentage, and the timestamp", () => {
    const html = buildReportHtml(input());

    expect(html).toContain("Tomato Late blight");
    expect(html).toContain("टमाटर");
    expect(html).toContain("94.3%");
    expect(html).toContain("Scanned:");
    expect(html).toContain(REPORT_ADVISORY.slice(0, 40));
  });

  it("escapes data that would otherwise close a tag", () => {
    const html = buildReportHtml(
      input({
        displayName: "<script>alert(1)</script>",
        recommendation: recommendation({ cause: 'Blight <b>"strain"</b>' }),
      }),
    );

    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("Blight &lt;b&gt;&quot;strain&quot;&lt;/b&gt;");
  });

  it("omits the chemical spray section for a healthy plant", () => {
    const diseased = buildReportHtml(input());
    const healthy = buildReportHtml(input({ isHealthy: true }));

    expect(diseased).toContain("Chemical spray");
    expect(diseased).toContain("Mancozeb 75% WP");
    expect(healthy).not.toContain("Chemical spray");
    expect(healthy).not.toContain("Mancozeb 75% WP");
    // The rest of the guidance still applies to a healthy plant.
    expect(healthy).toContain("Prevention");
  });

  it("strips the data's own bullet from farmer tips", () => {
    const html = buildReportHtml(input());

    expect(html).toContain("<li>Scout the field twice a week</li>");
    expect(html).not.toContain("•");
  });

  it("never prints the word null for an unreadable field", () => {
    const html = buildReportHtml(
      input({
        cropHindi: "",
        recommendation: recommendation({
          description: null as unknown as string,
          symptoms: [null as unknown as string, "Real symptom"],
          treatment: [{ name: "Mancozeb", dosage: null }],
        }),
      }),
    );

    expect(html).not.toContain("null");
    expect(html).toContain("Real symptom");
  });

  it("states the crop restriction only when one was applied", () => {
    expect(buildReportHtml(input())).not.toContain("Restricted to crop");
    expect(buildReportHtml(input({ cropFilter: "Tomato" }))).toContain("Restricted to crop: Tomato");
  });

  it("adds the verify-before-acting line only for an uncertain diagnosis", () => {
    expect(buildReportHtml(input())).not.toContain("Low confidence");
    expect(buildReportHtml(input({ isUncertain: true }))).toContain("Low confidence");
  });

  it("embeds an image data URL and ignores any other scheme", () => {
    const embedded = buildReportHtml(input({ imageDataUrl: "data:image/jpeg;base64,AAAA" }));
    expect(embedded).toContain('src="data:image/jpeg;base64,AAAA"');

    const rejected = buildReportHtml(input({ imageDataUrl: "javascript:alert(1)" }));
    expect(rejected).not.toContain("javascript:");
  });

  it("builds a report from a source with no candidates or guidance", () => {
    const html = buildReportHtml(input({ candidates: [], recommendation: null }));

    expect(html).toContain("Tomato Late blight");
    expect(html).not.toContain("Top candidates");
    expect(html).toContain(REPORT_ADVISORY.slice(0, 40));
  });
});

describe("reportFilename", () => {
  it("slugifies the display name and appends the scan date", () => {
    expect(reportFilename(input())).toBe("crop-diagnosis-tomato-late-blight-2026-08-30.html");
  });

  it("falls back to the date alone when the name has no usable characters", () => {
    expect(reportFilename(input({ displayName: "टमाटर" }))).toBe("crop-diagnosis-2026-08-30.html");
  });

  it("still returns a filename when the timestamp is unparseable", () => {
    expect(reportFilename(input({ createdAt: "not a date" }))).toBe(
      "crop-diagnosis-tomato-late-blight.html",
    );
  });
});

describe("downloadReport", () => {
  /** jsdom implements neither half of the Blob URL API, so the guard is the default path here. */
  it("reports failure instead of throwing when Blob URLs are unavailable", () => {
    expect(downloadReport("<!doctype html>", "report.html")).toBe(false);
  });

  it("clicks a download anchor and revokes the object URL", () => {
    const createObjectURL = vi.fn(() => "blob:report");
    const revokeObjectURL = vi.fn();
    const urls = URL as unknown as {
      createObjectURL?: typeof createObjectURL;
      revokeObjectURL?: typeof revokeObjectURL;
    };
    urls.createObjectURL = createObjectURL;
    urls.revokeObjectURL = revokeObjectURL;

    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(function (this: HTMLAnchorElement) {
        expect(this.download).toBe("report.html");
        expect(this.getAttribute("href")).toBe("blob:report");
      });

    try {
      expect(downloadReport("<!doctype html>", "report.html")).toBe(true);
      expect(click).toHaveBeenCalledTimes(1);
      expect(revokeObjectURL).toHaveBeenCalledWith("blob:report");
      // The anchor is temporary: nothing is left behind in the document.
      expect(document.querySelectorAll("a").length).toBe(0);
    } finally {
      delete urls.createObjectURL;
      delete urls.revokeObjectURL;
    }
  });
});
