/**
 * Response types for the `/api` surface, mirroring `backend/app/schemas.py` field for field.
 *
 * A field renamed on either side must be renamed on the other. The contract test in
 * `src/api/client.test.ts` (and the fixture check in task 19.2) asserts a real backend
 * response against these types, so drift fails a test rather than a page.
 *
 * Name mapping to the Pydantic models, where the suffix differs:
 *
 * | Backend                       | Here                       |
 * | ----------------------------- | -------------------------- |
 * | `TreatmentItemOut`            | `TreatmentItem`            |
 * | `FertilizerItemOut`           | `FertilizerItem`           |
 * | `PredictMetaOut`              | `PredictMeta`              |
 * | `HistoryItemOut`              | `HistoryItem`              |
 * | `ModelHealthOut`              | `ModelHealth`              |
 * | `RecommendationStoreHealthOut`| `RecommendationStoreHealth`|
 * | `ModelSummaryOut`             | `ModelSummary`             |
 * | `ClassMetadataResponse`       | `ClassMetadata`            |
 *
 * Two conventions carried over from the backend:
 *
 * - `confidence` is the raw softmax value in `[0, 1]`; `confidence_percent` is a computed
 *   field the backend always emits (that same value as a percentage rounded to one
 *   decimal). It is never optional, and the UI must not re-derive it, so the result card
 *   and the history list show the same number.
 * - Every `RecommendationOut` list field arrives as `[]` rather than being omitted, so a
 *   renderer can branch on emptiness alone.
 */

// --- prediction ---------------------------------------------------------------------

/** One of the top-3 candidates from the winning model (Req 5.5). */
export interface CandidateOut {
  label: string;
  display_name: string;
  /** Softmax confidence in `[0, 1]`. */
  confidence: number;
}

/** The single diagnosis returned for a submitted image (Req 5.4). */
export interface DiagnosisOut {
  label: string;
  display_name: string;
  crop: string;
  /** Hindi crop name; `""` when the data files have none. */
  crop_hindi: string;
  disease: string;
  is_healthy: boolean;
  /** Softmax confidence in `[0, 1]`. */
  confidence: number;
  /** Computed on the backend: `confidence * 100` rounded to one decimal. Always present. */
  confidence_percent: number;
  model_used: string;
  /** `true` when `confidence` fell below the threshold in `PredictMeta.confidence_threshold`. */
  is_uncertain: boolean;
}

/**
 * One `treatment` entry.
 *
 * The backend allows extra keys (`ConfigDict(extra="allow")`) because the data files are
 * hand-authored, so the index signature keeps an unexpected key typed instead of a
 * compile error — it renders as one more row.
 */
export interface TreatmentItem {
  name?: string | null;
  purpose?: string | null;
  application?: string | null;
  dosage?: string | null;
  interval?: string | null;
  safety?: string | null;
  [key: string]: unknown;
}

/** One `fertilizers` entry. Extra keys are permitted, as on `TreatmentItem`. */
export interface FertilizerItem {
  name?: string | null;
  purpose?: string | null;
  [key: string]: unknown;
}

/** The guidance block for a diagnosis (Req 7.9). */
export interface RecommendationOut {
  /** Resolved Recommendation_Store key; `null` only for the placeholder record. */
  source_key: string | null;
  /** How the key was resolved: `exact` | `normalized` | `pair` | `alias` | `placeholder`. */
  resolution_stage: string;
  is_placeholder: boolean;

  description: string;
  cause: string;
  best_time_to_spray: string;

  symptoms: string[];
  affected_parts: string[];
  organic_remedy: string[];
  chemical_spray: string[];
  preventive_measures: string[];
  /** `[]` when it duplicates `preventive_measures`, so each list renders once. */
  prevention: string[];
  safety_tips: string[];
  farmer_tips: string[];

  fertilizers: FertilizerItem[];
  treatment: TreatmentItem[];
}

/** Which models ran, the threshold in force, and the wall-clock cost. */
export interface PredictMeta {
  models_run: string[];
  /** Threshold in `[0, 1]` that `DiagnosisOut.is_uncertain` was decided against. */
  confidence_threshold: number;
  inference_ms: number;
  /**
   * The crop the prediction was restricted to, echoed back from the optional `crop` form field, or
   * `null` when the request carried none and every class was in play.
   *
   * Not a boolean and not optional: the UI has to be able to say *which* crop was applied, and it
   * must be able to distinguish "no crop was sent" from "the field is missing from this response".
   * A caller reading it can only branch on `null`, never on `undefined`.
   */
  crop_filter: string | null;
}

/** `POST /api/predict` `200` body. */
export interface PredictResponse {
  scan_id: string;
  image_url: string;
  /** ISO-8601 UTC with a `Z` suffix, e.g. `2026-08-30T15:04:05.123Z`. */
  created_at: string;
  diagnosis: DiagnosisOut;
  candidates: CandidateOut[];
  recommendation: RecommendationOut;
  meta: PredictMeta;
}

// --- history ------------------------------------------------------------------------

/** One Scan_Record as the history page renders it (Req 9.7). */
export interface HistoryItem {
  id: string;
  image_url: string;
  display_name: string;
  crop: string;
  crop_hindi: string;
  disease: string;
  /** Softmax confidence in `[0, 1]`. */
  confidence: number;
  /** Computed on the backend, same rounding as `DiagnosisOut.confidence_percent`. */
  confidence_percent: number;
  model_used: string;
  is_uncertain: boolean;
  is_healthy: boolean;
  /** ISO-8601 UTC with a `Z` suffix. */
  created_at: string;
}

/**
 * `GET /api/history/{scan_id}` body — mirrors the backend's `ScanDetailResponse` (Req 9.7).
 *
 * Every field of the list row plus the two blocks the list omits: the top candidates as stored, and
 * the guidance resolved for the label. Extending `HistoryItem` rather than restating its fields is
 * deliberate — the backend builds the detail from the same row, so a field added to one must appear
 * on the other, and inheritance makes that automatic instead of a thing to remember.
 *
 * `recommendation` is never optional: when no Recommendation_Store key resolves, the backend projects
 * the placeholder record with `is_placeholder: true` rather than omitting the block, so a renderer
 * branches on the flag and never on the field's presence.
 */
export interface ScanDetail extends HistoryItem {
  /** Top candidates as they were stored, highest confidence first (Req 5.5). */
  candidates: CandidateOut[];
  /** The guidance block; the placeholder record when the label resolved to nothing (Req 7.8). */
  recommendation: RecommendationOut;
}

/** `GET /api/history` body: newest first, with the paging window echoed back. */
export interface HistoryListResponse {
  total: number;
  limit: number;
  offset: number;
  items: HistoryItem[];
}

// --- health and metadata ------------------------------------------------------------

/** Per-model state on `GET /api/health` (Req 6.6, 10.3). */
export interface ModelHealth {
  role: string;
  loaded: boolean;
  checkpoint_present: boolean;
  input_size: number;
  error: string | null;
}

/** Data-layer state on `GET /api/health`; `unresolved` is `[]` in steady state (Req 7.7). */
export interface RecommendationStoreHealth {
  records: number;
  labels_checked: number;
  unresolved: string[];
}

/** `GET /api/health` body. Always `200` so "app up, models down" is distinguishable. */
export interface HealthResponse {
  /** `ok` (both models loaded) | `degraded` (exactly one) | `unavailable` (neither). */
  status: string;
  device: string;
  /** Keyed by model id, e.g. `vit_b16`, `efficientnet_b3`. */
  models: Record<string, ModelHealth>;
  recommendation_store: RecommendationStoreHealth;
  uptime_seconds: number;
}

/** One entry of the `models` list on `GET /api/meta/classes`. */
export interface ModelSummary {
  id: string;
  role: string;
  label_count: number;
  input_size: number;
  loaded: boolean;
}

/** `GET /api/meta/classes` body. Every count is derived at startup (Req 2.2). */
export interface ClassMetadata {
  crops: string[];
  crop_count: number;
  class_count: number;
  healthy_class_count: number;
  recommendation_count: number;
  confidence_threshold: number;
  max_upload_mb: number;
  /** Display names, e.g. `["JPEG", "PNG", "WebP"]`. */
  accepted_formats: string[];
  models: ModelSummary[];
}

// --- errors -------------------------------------------------------------------------

/** The inner object of the single error envelope. */
export interface ErrorBody {
  code: string;
  /** User-facing text; the client prefers this over any local fallback (Req 10.7). */
  message: string;
}

/** Every non-2xx body: `{ "error": { "code": ..., "message": ... } }`. */
export interface ErrorResponse {
  error: ErrorBody;
}
