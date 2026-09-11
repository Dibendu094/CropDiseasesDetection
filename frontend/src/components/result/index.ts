/**
 * The result-display components, re-exported from one place so `DiagnosisPage` imports
 * `{ ResultBox }` from `components/result` rather than reaching into individual files — the same
 * arrangement as `components/ui` and `components/upload`.
 *
 * In practice a page only needs `ResultBox`: it owns the five states and composes the rest. The
 * others are exported because they are the units a test drives directly, and because the copy
 * constants (`UNCERTAINTY_ADVICE`, `HEALTHY_BADGE_LABEL`) are strings a live-region announcement or
 * an assertion should share rather than duplicate.
 *
 * `DownloadReportButton` is exported alongside it because the history page will reuse the same control
 * over a scan detail — the report itself is built by `lib/report.ts`, which takes a flat input rather
 * than a `PredictResponse` for exactly that reason.
 *
 * `readOptionalText`, `hasTreatmentContent`, and `stripLeadingBullet` are the three data rules this
 * folder applies to hand-authored recommendation records — a blank field is absent, a treatment entry
 * with no readable column is not a row, and a `farmer_tips` entry arrives with its own bullet. A test
 * asserting those behaviours uses the same functions the renderer used.
 *
 * Each component also has a default export in its own module, matching the rest of the codebase.
 */

export {
  DiagnosisHeader,
  type DiagnosisAccent,
  type DiagnosisHeaderProps,
} from "./DiagnosisHeader";
export {
  DOWNLOAD_REPORT_BUSY_LABEL,
  DOWNLOAD_REPORT_ERROR,
  DOWNLOAD_REPORT_LABEL,
  DownloadReportButton,
  type DownloadReportButtonProps,
} from "./DownloadReportButton";
export { HEALTHY_BADGE_LABEL, HealthyResult, type HealthyResultProps } from "./HealthyResult";
export { PlaceholderNotice, type PlaceholderNoticeProps } from "./PlaceholderNotice";
export {
  RecommendationSections,
  stripLeadingBullet,
  type RecommendationSectionsProps,
} from "./RecommendationSections";
export {
  ERROR_TITLE,
  MAX_STAGGER_STEPS,
  ResultBox,
  STAGGER_STEP_MS,
  UNREACHABLE_TITLE,
  type ResultBoxFailureProps,
  type ResultBoxIdleProps,
  type ResultBoxPendingProps,
  type ResultBoxProps,
  type ResultBoxSuccessProps,
  type ResultState,
} from "./ResultBox";
export {
  TREATMENT_TABLE_QUERY,
  TreatmentTable,
  hasTreatmentContent,
  readOptionalText,
  type TreatmentColumn,
  type TreatmentTableProps,
} from "./TreatmentTable";
export {
  UNCERTAINTY_ADVICE,
  UncertaintyBanner,
  type UncertaintyBannerProps,
} from "./UncertaintyBanner";
