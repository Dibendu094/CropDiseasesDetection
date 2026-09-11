"""Health and metadata routes.

Two reads of state that startup already computed, and no work of their own.

``GET /api/health`` always answers ``200`` (Req 6.6, 10.3). That is the whole
point of it: a monitor has to be able to tell "the app is up but the models are
down" from "the app is down", and a 503 here would make those two look the same.
The model states come straight off the registry, so a checkpoint that failed to
load reports ``loaded=false`` with its stable error code rather than disappearing
from the payload.

``GET /api/meta/classes`` feeds the Home page counts (Req 2.2). Every figure is
derived: the crop list and the four counts come from
``RecommendationStore.metadata``, which measured them when the two data files were
merged at startup; the threshold, the upload cap and the accepted formats come
from settings; the model rows come from the registry. No number in this module is
a literal, so editing a data file moves the Home page without a code change.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends

from ..config import Settings
from ..dependencies import (
    get_app_settings,
    get_coverage,
    get_registry,
    get_store,
    get_uptime_seconds,
)
from ..logging_config import get_logger
from ..schemas import (
    ClassMetadataResponse,
    ErrorResponse,
    HealthResponse,
    ModelHealthOut,
    ModelSummaryOut,
    RecommendationStoreHealthOut,
)
from ..services.label_coverage import CoverageReport
from ..services.model_registry import ModelRegistry
from ..services.recommendations import RecommendationStore

__all__ = ["router", "format_accepted", "max_upload_mb"]

log = get_logger(__name__)

router = APIRouter(tags=["meta"])

_FORMAT_DISPLAY: dict[str, str] = {"JPEG": "JPEG", "PNG": "PNG", "WEBP": "WebP"}
"""How the sniffed format names are spelled for humans. ``WEBP`` -> ``WebP``."""

_BYTES_PER_MB = 1024 * 1024


def format_accepted(formats: tuple[str, ...] | list[str]) -> list[str]:
    """Render ``settings.allowed_formats`` for display, preserving configured order."""
    return [_FORMAT_DISPLAY.get(str(fmt).upper(), str(fmt)) for fmt in formats]


def max_upload_mb(max_upload_bytes: int) -> int:
    """The upload cap in whole megabytes, as the UI states it (Req 4.3)."""
    return max(0, int(max_upload_bytes) // _BYTES_PER_MB)


@router.get(
    "/health",
    response_model=HealthResponse,
    summary="Liveness and per-model readiness",
    responses={500: {"model": ErrorResponse}},
)
def health(
    registry: ModelRegistry = Depends(get_registry),
    coverage: CoverageReport = Depends(get_coverage),
    uptime_seconds: float = Depends(get_uptime_seconds),
) -> HealthResponse:
    """Report app liveness plus per-model state. Always ``200`` (Req 6.6, 10.3).

    ``status`` is ``ok`` when both models are loaded, ``degraded`` when exactly
    one is, and ``unavailable`` when neither is -- and even ``unavailable`` comes
    back with a 200, because the app answering at all is the signal.
    """
    return HealthResponse(
        status=registry.status(),
        device=str(registry.device),
        models={
            model_id: ModelHealthOut(**state)
            for model_id, state in registry.model_states().items()
        },
        recommendation_store=RecommendationStoreHealthOut(**coverage.as_health_dict()),
        uptime_seconds=uptime_seconds,
    )


@router.get(
    "/meta/classes",
    response_model=ClassMetadataResponse,
    summary="Crop and class coverage, upload limits, and model summaries",
    responses={500: {"model": ErrorResponse}},
)
def class_metadata(
    store: RecommendationStore = Depends(get_store),
    registry: ModelRegistry = Depends(get_registry),
    settings: Settings = Depends(get_app_settings),
) -> ClassMetadataResponse:
    """Every figure the Home page shows, measured at startup (Req 2.2).

    ``class_count`` is the number of distinct canonical ``(crop, disease)`` pairs
    reachable from the merged data -- not the 91 classes of a single model, and
    not the 140 stored records, which include near-duplicates such as
    ``Cotton_Healthy_Leaf`` / ``Cotton_Healthy_Plant``.
    """
    figures = store.metadata.as_dict()
    return ClassMetadataResponse(
        crops=figures["crops"],
        crop_count=figures["crop_count"],
        class_count=figures["class_count"],
        healthy_class_count=figures["healthy_class_count"],
        recommendation_count=figures["recommendation_count"],
        confidence_threshold=settings.confidence_threshold,
        max_upload_mb=max_upload_mb(settings.max_upload_bytes),
        accepted_formats=format_accepted(settings.allowed_formats),
        models=[
            ModelSummaryOut(
                id=model.spec.id,
                role=model.spec.role,
                label_count=len(model.labels),
                input_size=model.spec.input_size,
                loaded=model.loaded,
            )
            for model in registry.models().values()
        ],
    )
