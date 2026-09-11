"""App factory, lifespan, CORS, and the four exception handlers.

**Startup order is fixed, and the order is the point.** Steps 3-5 (label maps,
recommendation store, resolver plus the 182-label coverage assertion) cost well
under 100 ms between them and run *before* step 6, which loads ~1 GB of ViT
weights and takes tens of seconds. A data problem therefore surfaces in the first
second of boot rather than after the model load, and the coverage assertion is
allowed to check the resolver against vocabularies that are already known to hold
91 labels each.

1. configure logging, log every resolved path
2. create ``uploads/``, open the database, apply the schema, sweep orphans
3. load both label maps -- 91 labels each
4. build the Recommendation_Store -- 140 records
5. build the Label_Resolver, run the coverage assertion over all 182 labels, build
   the Crop_Index the optional ``crop`` predict hint masks with
6. load both checkpoints into the Model Registry
7. log the readiness summary

Step 6 degrades rather than aborts (Req 10.3): a missing or broken checkpoint marks
that model unavailable, ``/api/health`` reports it, and the cascade routes around
it. Steps 2-5 raise, because there is nothing to serve without them.

Set ``SKIP_MODEL_LOAD=1`` to run steps 1-5 and 7 and skip only the checkpoint
reads. The registry is still built, both models are still described, and every
route still exists -- they simply report ``loaded=false`` / ``error="skipped"``, so
``/api/health`` answers ``unavailable`` and ``/api/predict`` answers ``503``. It
exists for fast smoke tests and for frontend work that does not need weights; the
default is to load normally.

**The 500 body is a constant.** The catch-all handler logs the traceback server-side
with ``exc_info=True`` and returns :data:`~app.errors.INTERNAL_ERROR_MESSAGE`
verbatim. It never interpolates ``str(exc)``, so a ``FileNotFoundError`` carrying
``D:\\Crop_Diseases_Prediction\\models\\...`` cannot leak the filesystem layout and
the word ``Traceback`` cannot appear in a response body (Req 10.6). FastAPI's own
``RequestValidationError`` and ``HTTPException`` are re-rendered in the same
envelope, so the frontend parses exactly one error shape.
"""

from __future__ import annotations

import os
import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import torch
from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from .config import Settings, get_settings
from .db.database import connection, ensure_directories, init_db
from .db.repository import sweep_orphaned_images
from .errors import (
    INTERNAL_ERROR_CODE,
    INTERNAL_ERROR_MESSAGE,
    ApiError,
    InvalidQueryError,
    error_envelope,
)
from .logging_config import configure_logging, get_logger, log_resolved_paths, log_readiness_summary
from .routers import history, meta, predict
from .services.crop_index import build_crop_index
from .services.label_coverage import check_label_coverage
from .services.label_maps import load_label_maps
from .services.label_resolver import build_label_resolver
from .services.model_registry import LoadedModel, ModelSpec, build_registry
from .services.recommendations import EXPECTED_RECORD_COUNT, build_recommendation_store

__all__ = [
    "API_PREFIX",
    "SKIP_MODEL_LOAD_ENV",
    "app",
    "create_app",
    "lifespan",
    "skip_model_load",
]

log = get_logger(__name__)

API_PREFIX = "/api"

SKIP_MODEL_LOAD_ENV = "SKIP_MODEL_LOAD"
"""Escape hatch: set to ``1`` to boot without reading the checkpoints."""

_TRUTHY = {"1", "true", "yes", "on"}

_ALLOWED_METHODS = ["GET", "POST", "DELETE", "OPTIONS"]
_ALLOWED_HEADERS = ["Content-Type"]
_CORS_MAX_AGE = 600

# Static per-status text for re-rendered HTTPExceptions. A 5xx never carries the
# exception's own detail, for the same reason the catch-all handler does not.
_HTTP_ERROR_CODES: dict[int, str] = {
    400: "BAD_REQUEST",
    404: "NOT_FOUND",
    405: "METHOD_NOT_ALLOWED",
    413: "IMAGE_TOO_LARGE",
    415: "UNSUPPORTED_FORMAT",
    422: "INVALID_QUERY",
}
_HTTP_ERROR_FALLBACK = "That request could not be completed."


def skip_model_load() -> bool:
    """Whether ``SKIP_MODEL_LOAD`` asks startup to skip the checkpoint reads."""
    return os.getenv(SKIP_MODEL_LOAD_ENV, "").strip().lower() in _TRUTHY


def _skipping_loader(
    spec: ModelSpec, labels: list[str], device: torch.device
) -> LoadedModel:
    """Stand in for the real loader when ``SKIP_MODEL_LOAD`` is set.

    Describes the model fully -- spec, role, input size, its 91 labels, whether the
    checkpoint file is there -- while reading nothing, so metadata and health stay
    truthful and no weights are touched.
    """
    present = spec.checkpoint.exists()
    log.warning(
        "%s: skipping checkpoint load (%s=1); checkpoint %s",
        spec.id,
        SKIP_MODEL_LOAD_ENV,
        "present" if present else "MISSING",
    )
    return LoadedModel(
        spec=spec,
        module=None,
        labels=list(labels),
        loaded=False,
        error="skipped",
        checkpoint_present=present,
    )


# --- lifespan --------------------------------------------------------------


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """Run the seven startup steps in order, then serve.

    Raises:
        Exception: anything steps 2-5 raise propagates and aborts startup -- an
            unopenable database or a malformed data file leaves nothing to serve.
            Step 6 is the exception: a bad checkpoint degrades to an unavailable
            model (Req 10.3).
    """
    settings: Settings = getattr(app.state, "settings", None) or get_settings()
    app.state.settings = settings
    app.state.start_time = time.monotonic()

    # 1. logging and paths
    configure_logging(settings.log_level)
    log.info("starting crop disease detection API")
    log_resolved_paths(settings.resolved_paths(), logger=log)

    # 2. uploads directory, database, schema, orphan sweep
    ensure_directories(settings)
    init_db(settings=settings)
    with connection(settings=settings) as conn:
        sweep_orphaned_images(conn, settings=settings)

    # 3. label maps (the loaders enforce 91 entries each; re-checked here so a
    #    relaxed loader could not quietly change the class count)
    label_maps = load_label_maps(settings)
    expected_labels = int(settings.num_classes)
    for name, labels in (
        ("effnet", label_maps.effnet_labels),
        ("vit", label_maps.vit_labels),
    ):
        if len(labels) != expected_labels:
            raise RuntimeError(
                f"{name} label map holds {len(labels)} labels, expected {expected_labels}"
            )
    log.info(
        "label maps ready: effnet=%d vit=%d (%d labels total)",
        len(label_maps.effnet_labels),
        len(label_maps.vit_labels),
        len(label_maps.all_labels()),
    )

    # 4. recommendation store
    store = build_recommendation_store(settings)
    if len(store) != EXPECTED_RECORD_COUNT:
        # A warning, not a failure: the data may legitimately grow, and every
        # count the API reports is derived rather than asserted.
        log.warning(
            "recommendation store holds %d records, expected %d",
            len(store),
            EXPECTED_RECORD_COUNT,
        )
    log.info("recommendation store ready: %s", store.metadata.as_dict())

    # 5. resolver plus the coverage assertion over all 182 labels (Req 7.7), then the
    #    crop index the optional predict hint masks with. Built here, from the objects
    #    that already exist, so no request ever resolves 182 labels to find a crop.
    resolver = build_label_resolver(store, label_maps)
    coverage = check_label_coverage(resolver, label_maps)
    if not coverage.complete:
        log.error(
            "label coverage incomplete: %d of %d label(s) resolved to the placeholder",
            len(coverage.unresolved),
            coverage.labels_checked,
        )
    crop_index = build_crop_index(store, label_maps, resolver)

    # 6. checkpoints (Req 6.1). Degrades, never aborts (Req 10.3).
    if skip_model_load():
        log.warning("%s is set: booting without model weights", SKIP_MODEL_LOAD_ENV)
        registry = build_registry(settings, label_maps, loader=_skipping_loader, load=True)
    else:
        registry = build_registry(settings, label_maps, load=True)

    app.state.registry = registry
    app.state.store = store
    app.state.resolver = resolver
    app.state.coverage = coverage
    app.state.label_maps = label_maps
    app.state.crop_index = crop_index

    # 7. readiness summary
    log_readiness_summary(
        models=registry.model_states(),
        stage_histogram=coverage.histograms(),
        record_counts={
            "records": len(store),
            "crops": store.metadata.crop_count,
            "classes": store.metadata.class_count,
            "labels": coverage.labels_checked,
        },
        unresolved=list(coverage.unresolved),
        device=str(registry.device),
        logger=log,
    )

    try:
        yield
    finally:
        log.info("shutting down crop disease detection API")


# --- exception handlers ----------------------------------------------------


async def api_error_handler(request: Request, exc: ApiError) -> JSONResponse:
    """Render any :class:`~app.errors.ApiError` as its own envelope.

    One handler for all nine subclasses: each carries its status, code and
    user-visible message, so there is nothing to decide here.
    """
    log.info(
        "%s %s -> %d %s", request.method, request.url.path, exc.status, exc.code
    )
    return JSONResponse(status_code=exc.status, content=exc.to_dict())


async def validation_error_handler(
    request: Request, exc: RequestValidationError
) -> JSONResponse:
    """Re-render FastAPI's own validation failure in the standard envelope.

    In practice this is out-of-range ``limit`` / ``offset`` on the history list,
    which the design maps to ``422 INVALID_QUERY``. The offending locations are
    logged; the body carries only the static message, never the raw input.
    """
    error = InvalidQueryError()
    log.info(
        "%s %s -> %d %s (%s)",
        request.method,
        request.url.path,
        error.status,
        error.code,
        [".".join(str(part) for part in item.get("loc", ())) for item in exc.errors()],
    )
    return JSONResponse(
        status_code=error.status, content=error_envelope(error.code, error.message)
    )


async def http_exception_handler(
    request: Request, exc: StarletteHTTPException
) -> JSONResponse:
    """Re-render an ``HTTPException`` (unknown route, wrong method) in the envelope.

    A 5xx detail is discarded in favour of the static internal-error message; a
    4xx detail is a string this application or Starlette wrote, so it is safe to
    pass through. ``exc.headers`` is preserved because a ``405`` carries ``Allow``.
    """
    status_code = int(exc.status_code)
    if status_code >= 500:
        code, message = INTERNAL_ERROR_CODE, INTERNAL_ERROR_MESSAGE
    else:
        code = _HTTP_ERROR_CODES.get(status_code, f"HTTP_{status_code}")
        detail = exc.detail if isinstance(exc.detail, str) and exc.detail else None
        message = detail or _HTTP_ERROR_FALLBACK

    log.info("%s %s -> %d %s", request.method, request.url.path, status_code, code)
    return JSONResponse(
        status_code=status_code,
        content=error_envelope(code, message),
        headers=getattr(exc, "headers", None),
    )


async def unhandled_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    """Last resort: log the traceback, return the static 500 body (Req 10.6).

    ``str(exc)`` is deliberately absent from the response. The traceback goes to
    the log, where an operator can read it; the client gets one fixed sentence, so
    no path, no exception type and no ``Traceback`` text can leave the process.
    """
    log.error(
        "unhandled error on %s %s", request.method, request.url.path, exc_info=True
    )
    return JSONResponse(
        status_code=500,
        content=error_envelope(INTERNAL_ERROR_CODE, INTERNAL_ERROR_MESSAGE),
    )


# --- app factory -----------------------------------------------------------


def create_app(settings: Settings | None = None) -> FastAPI:
    """Build the application: routers under ``/api``, CORS, exception handlers.

    Args:
        settings: overrides the process settings, for tests that need a temporary
            uploads directory and database.
    """
    cfg = settings or get_settings()

    app = FastAPI(
        title="Crop Disease Detection API",
        version="1.0.0",
        summary="Leaf-image diagnosis with a two-model confidence cascade",
        lifespan=lifespan,
    )

    app.state.settings = cfg
    # Declared up front so a provider reading state before startup sees None
    # rather than an AttributeError.
    app.state.registry = None
    app.state.store = None
    app.state.resolver = None
    app.state.coverage = None
    app.state.label_maps = None
    app.state.crop_index = None
    app.state.start_time = None

    # An explicit origin list, never ["*"] and never a regex (Req 13.5). Starlette
    # compares origins by exact string, so http://localhost:5173 admits neither
    # http://localhost:5173.evil.com nor https://localhost:5173.
    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(cfg.cors_allow_origins),
        allow_credentials=False,  # no cookies, no auth headers
        allow_methods=_ALLOWED_METHODS,
        allow_headers=_ALLOWED_HEADERS,
        max_age=_CORS_MAX_AGE,
    )

    app.include_router(meta.router, prefix=API_PREFIX)
    app.include_router(predict.router, prefix=API_PREFIX)
    app.include_router(history.router, prefix=API_PREFIX)

    app.add_exception_handler(ApiError, api_error_handler)  # type: ignore[arg-type]
    app.add_exception_handler(RequestValidationError, validation_error_handler)  # type: ignore[arg-type]
    app.add_exception_handler(StarletteHTTPException, http_exception_handler)  # type: ignore[arg-type]
    app.add_exception_handler(HTTPException, http_exception_handler)  # type: ignore[arg-type]
    app.add_exception_handler(Exception, unhandled_exception_handler)  # type: ignore[arg-type]

    return app


app = create_app()
"""The ASGI application. ``uvicorn app.main:app --reload`` from ``backend/``."""
