"""Pydantic v2 response models for the public API surface.

Every model here corresponds to a payload in the design's "API surface" section, field for
field. `frontend/src/api/types.ts` mirrors these shapes, so a field renamed here must be
renamed there as well.

Two conventions worth knowing before editing:

* `confidence_percent` is derived, never stored and never accepted as input. It is the
  softmax confidence expressed as a percentage rounded to one decimal place, so the UI and
  the history list agree on the same rounding.
* `TreatmentItemOut` and `FertilizerItemOut` declare every known key as optional and allow
  extras. The data files are hand-authored, so an unexpected key renders as one more row
  instead of raising a validation error on the way out.
"""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field, computed_field

__all__ = [
    "CandidateOut",
    "DiagnosisOut",
    "TreatmentItemOut",
    "FertilizerItemOut",
    "RecommendationOut",
    "PredictMetaOut",
    "PredictResponse",
    "HistoryItemOut",
    "HistoryListResponse",
    "ScanDetailResponse",
    "ModelHealthOut",
    "RecommendationStoreHealthOut",
    "HealthResponse",
    "ModelSummaryOut",
    "ClassMetadataResponse",
    "ErrorBody",
    "ErrorResponse",
]


def _as_percent(confidence: float) -> float:
    """Confidence in ``[0, 1]`` as a percentage rounded to one decimal place."""
    return round(confidence * 100.0, 1)


# --- prediction -------------------------------------------------------------------------


class CandidateOut(BaseModel):
    """One of the three top candidates from the winning model (Req 5.5)."""

    label: str
    display_name: str
    confidence: float = Field(ge=0.0, le=1.0)


class DiagnosisOut(BaseModel):
    """The single diagnosis returned for a submitted image (Req 5.4, 5.6, 8.2)."""

    model_config = ConfigDict(protected_namespaces=())

    label: str
    display_name: str
    crop: str
    crop_hindi: str = ""
    disease: str
    is_healthy: bool
    confidence: float = Field(ge=0.0, le=1.0)
    model_used: str
    is_uncertain: bool

    @computed_field  # type: ignore[prop-decorator]
    @property
    def confidence_percent(self) -> float:
        return _as_percent(self.confidence)


class TreatmentItemOut(BaseModel):
    """One `treatment` entry. Unknown keys are preserved rather than rejected."""

    model_config = ConfigDict(extra="allow")

    name: str | None = None
    purpose: str | None = None
    application: str | None = None
    dosage: str | None = None
    interval: str | None = None
    safety: str | None = None


class FertilizerItemOut(BaseModel):
    """One `fertilizers` entry. Unknown keys are preserved rather than rejected."""

    model_config = ConfigDict(extra="allow")

    name: str | None = None
    purpose: str | None = None


class RecommendationOut(BaseModel):
    """The guidance block for a diagnosis (Req 7.9).

    `source_key` is the resolved Recommendation_Store key and is ``None`` only for the
    placeholder record. `resolution_stage` is one of
    ``exact | normalized | pair | alias | placeholder``.

    Every field has a defaulted empty value so a record that omits one still serialises
    with the key present, which lets the renderer decide on emptiness alone. `prevention`
    arrives as ``[]`` when it duplicates `preventive_measures`.
    """

    source_key: str | None = None
    resolution_stage: str
    is_placeholder: bool = False

    description: str = ""
    cause: str = ""
    best_time_to_spray: str = ""

    symptoms: list[str] = Field(default_factory=list)
    affected_parts: list[str] = Field(default_factory=list)
    organic_remedy: list[str] = Field(default_factory=list)
    chemical_spray: list[str] = Field(default_factory=list)
    preventive_measures: list[str] = Field(default_factory=list)
    prevention: list[str] = Field(default_factory=list)
    safety_tips: list[str] = Field(default_factory=list)
    farmer_tips: list[str] = Field(default_factory=list)

    fertilizers: list[FertilizerItemOut] = Field(default_factory=list)
    treatment: list[TreatmentItemOut] = Field(default_factory=list)


class PredictMetaOut(BaseModel):
    """Which models actually ran, the threshold in force, and the wall-clock cost.

    `crop_filter` is the canonical crop name the winning model's distribution was actually
    restricted to, or ``None`` when the prediction ran over the whole vocabulary. It is
    ``None`` both when no `crop` was submitted and when a submitted hint could not be
    honoured, so the UI can show "constrained to Tomato" only when that is true.
    """

    models_run: list[str] = Field(default_factory=list)
    confidence_threshold: float
    inference_ms: int
    crop_filter: str | None = None


class PredictResponse(BaseModel):
    """`POST /api/predict` `200` body."""

    scan_id: str
    image_url: str
    created_at: str
    diagnosis: DiagnosisOut
    candidates: list[CandidateOut] = Field(default_factory=list)
    recommendation: RecommendationOut
    meta: PredictMetaOut


# --- history ----------------------------------------------------------------------------


class HistoryItemOut(BaseModel):
    """One Scan_Record as the History_Page renders it (Req 9.7)."""

    model_config = ConfigDict(protected_namespaces=())

    id: str
    image_url: str
    display_name: str
    crop: str
    crop_hindi: str = ""
    disease: str
    confidence: float = Field(ge=0.0, le=1.0)
    model_used: str
    is_uncertain: bool
    is_healthy: bool
    created_at: str

    @computed_field  # type: ignore[prop-decorator]
    @property
    def confidence_percent(self) -> float:
        return _as_percent(self.confidence)


class HistoryListResponse(BaseModel):
    """`GET /api/history` body: newest first, with the paging window echoed back."""

    total: int
    limit: int
    offset: int
    items: list[HistoryItemOut] = Field(default_factory=list)


class ScanDetailResponse(HistoryItemOut):
    """`GET /api/history/{scan_id}` body: one stored scan in full.

    Everything the history list row carries, plus the two blocks the list deliberately
    leaves out: the stored top-3 `candidates` and the `recommendation` rebuilt by resolving
    the row's `recommendation_key` through the store.

    `recommendation` is the same `RecommendationOut` the predict route returns, placeholder
    included, so the frontend renders one recommendation type from either endpoint.
    """

    candidates: list[CandidateOut] = Field(default_factory=list)
    recommendation: RecommendationOut


# --- health and metadata ----------------------------------------------------------------


class ModelHealthOut(BaseModel):
    """Per-model state on `GET /api/health` (Req 6.6, 10.3)."""

    role: str
    loaded: bool
    checkpoint_present: bool
    input_size: int
    error: str | None = None


class RecommendationStoreHealthOut(BaseModel):
    """Data-layer state on `GET /api/health`: `unresolved` is empty in steady state (Req 7.7)."""

    records: int
    labels_checked: int
    unresolved: list[str] = Field(default_factory=list)


class HealthResponse(BaseModel):
    """`GET /api/health` body. Always `200`; `status` is `ok` / `degraded` / `unavailable`."""

    status: str
    device: str
    models: dict[str, ModelHealthOut] = Field(default_factory=dict)
    recommendation_store: RecommendationStoreHealthOut
    uptime_seconds: float


class ModelSummaryOut(BaseModel):
    """One entry of the `models` list on `GET /api/meta/classes`."""

    id: str
    role: str
    label_count: int
    input_size: int
    loaded: bool


class ClassMetadataResponse(BaseModel):
    """`GET /api/meta/classes` body. Every count is derived at startup (Req 2.2)."""

    crops: list[str] = Field(default_factory=list)
    crop_count: int
    class_count: int
    healthy_class_count: int
    recommendation_count: int
    confidence_threshold: float
    max_upload_mb: int
    accepted_formats: list[str] = Field(default_factory=list)
    models: list[ModelSummaryOut] = Field(default_factory=list)


# --- errors -----------------------------------------------------------------------------


class ErrorBody(BaseModel):
    """The inner object of the single error envelope."""

    code: str
    message: str


class ErrorResponse(BaseModel):
    """Every non-2xx body: `{"error": {"code": ..., "message": ...}}`."""

    error: ErrorBody
