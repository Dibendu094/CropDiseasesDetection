"""FastAPI dependency providers.

Everything expensive is built exactly once, in the lifespan handler, and parked on
``app.state``. This module is the *only* way a route reaches those objects, and it
never builds them: a provider either hands back what startup put on the state or
reports the service unavailable.

That distinction matters most for the model registry (Req 6.3). ``ModelRegistry``
holds ~1 GB of ViT weights, so a provider that fell back to
``build_registry()`` on a missing state attribute would silently load a second
copy of both checkpoints per worker. It raises
:class:`~app.errors.ServiceUnavailableError` instead -- a 503 is the honest
answer when the app was constructed without its lifespan (which in practice means
a test that forgot ``with TestClient(app):``).

The four data singletons -- recommendation store, label resolver, crop index,
coverage report -- are cheap (two JSON reads and a handful of dict indexes,
< 100 ms) and each has an
``lru_cache``'d process-wide getter. Those getters are used as a fallback, so a
directly-constructed app still serves metadata rather than 503ing.

The repository is the odd one out: it is *per request*, not a singleton, because
it wraps one SQLite connection. ``app.db.database.get_connection`` yields that
connection and closes it in a ``finally``; :func:`get_repository` just binds it to
a :class:`~app.db.repository.ScanRepository`. Route handlers that use it are sync
``def``, so FastAPI runs them in its worker threadpool and the connection is not
shared across threads.
"""

from __future__ import annotations

import sqlite3
from collections.abc import Iterator
from typing import Any

from fastapi import Depends, Request

from .config import Settings, get_settings
from .db.database import get_connection
from .db.repository import ScanRepository
from .errors import ServiceUnavailableError
from .logging_config import get_logger
from .services.crop_index import CropIndex, get_crop_index as get_cached_crop_index
from .services.label_coverage import CoverageReport, get_label_coverage
from .services.label_resolver import LabelResolver, get_label_resolver
from .services.model_registry import ModelRegistry
from .services.recommendations import RecommendationStore, get_recommendation_store

__all__ = [
    "get_app_settings",
    "get_registry",
    "get_store",
    "get_resolver",
    "get_crop_index",
    "get_coverage",
    "get_db_connection",
    "get_repository",
    "get_start_time",
    "get_uptime_seconds",
]

log = get_logger(__name__)


def _from_state(request: Request, name: str) -> Any | None:
    """Read ``name`` off ``app.state``, or ``None`` when startup never set it."""
    return getattr(request.app.state, name, None)


# --- settings --------------------------------------------------------------


def get_app_settings() -> Settings:
    """The process-wide :class:`~app.config.Settings`.

    Declared as a zero-argument provider on purpose: FastAPI inspects dependency
    signatures, and a ``Settings`` parameter (a Pydantic model) would be mistaken
    for a request body field.
    """
    return get_settings()


# --- singletons owned by the lifespan handler ------------------------------


def get_registry(request: Request) -> ModelRegistry:
    """The one :class:`~app.services.model_registry.ModelRegistry` (Req 6.3).

    Raises:
        ServiceUnavailableError: the lifespan handler never ran, so no registry
            exists. Constructing one here would load ~1 GB of weights inside a
            request, so it is refused as ``503 MODELS_UNAVAILABLE``.
    """
    registry = _from_state(request, "registry")
    if registry is None:
        log.error("app.state.registry is unset; the lifespan handler did not run")
        raise ServiceUnavailableError
    return registry


def get_store(request: Request) -> RecommendationStore:
    """The 140-record Recommendation_Store built at startup."""
    store = _from_state(request, "store")
    if store is None:
        log.warning("app.state.store is unset; falling back to the cached store")
        return get_recommendation_store()
    return store


def get_resolver(request: Request) -> LabelResolver:
    """The Label_Resolver with its three indexes already built."""
    resolver = _from_state(request, "resolver")
    if resolver is None:
        log.warning("app.state.resolver is unset; falling back to the cached resolver")
        return get_label_resolver()
    return resolver


def get_crop_index(request: Request) -> CropIndex:
    """The Crop_Index built at startup: ``{normalized crop: per-model class indices}``.

    Cheap to rebuild (it reads no files of its own), so a missing state attribute
    falls back to the cached process-wide index rather than refusing the request.
    The predict route treats an unusable index as "no hint" anyway.
    """
    crop_index = _from_state(request, "crop_index")
    if crop_index is None:
        log.warning("app.state.crop_index is unset; falling back to the cached index")
        return get_cached_crop_index()
    return crop_index


def get_coverage(request: Request) -> CoverageReport:
    """The startup coverage report over all 182 labels (Req 7.7)."""
    coverage = _from_state(request, "coverage")
    if coverage is None:
        log.warning("app.state.coverage is unset; falling back to the cached report")
        return get_label_coverage()
    return coverage


def get_start_time(request: Request) -> float | None:
    """The ``time.monotonic()`` reading taken when the lifespan handler started."""
    value = _from_state(request, "start_time")
    return float(value) if isinstance(value, (int, float)) else None


def get_uptime_seconds(request: Request) -> float:
    """Seconds since startup, rounded to one decimal. ``0.0`` when unknown."""
    import time  # noqa: PLC0415 - local so this module stays import-cheap

    start = get_start_time(request)
    if start is None:
        return 0.0
    return round(max(0.0, time.monotonic() - start), 1)


# --- per-request database access -------------------------------------------


def get_db_connection(
    settings: Settings = Depends(get_app_settings),
) -> Iterator[sqlite3.Connection]:
    """One SQLite connection per request, closed in a ``finally``.

    Delegates to :func:`app.db.database.get_connection` with ``yield from``, so
    that module keeps sole ownership of the pragmas and the close. The wrapper
    exists only to feed it settings through DI rather than through a parameter
    FastAPI would read as a request body.
    """
    yield from get_connection(settings)


def get_repository(
    conn: sqlite3.Connection = Depends(get_db_connection),
    settings: Settings = Depends(get_app_settings),
) -> ScanRepository:
    """A :class:`~app.db.repository.ScanRepository` over this request's connection."""
    return ScanRepository(conn, settings=settings)
