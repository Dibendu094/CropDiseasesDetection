"""Scan history: list, detail, image bytes, delete.

Four routes over one table and one directory, and four details that are easy to
get wrong:

* **Newest first, always.** ``ScanRepository.list`` orders
  ``created_at DESC, id DESC`` off ``idx_scans_created_at``; the router only echoes
  the paging window back (Req 9.2).
* **The detail route resolves guidance, it does not read it back.** A row stores a
  ``recommendation_key`` and the stage that found it, never the guidance text, so
  ``GET /api/history/{scan_id}`` re-projects the store record through
  :meth:`~app.services.recommendations.RecommendationView.to_out` -- the same call
  the predict route makes. A ``NULL`` or now-missing key yields the placeholder
  projection, so the frontend has exactly one recommendation shape to render.
* **404 is two different things.** An unknown ``scan_id`` is ``NOT_FOUND``. A row
  that exists whose image file is gone is ``IMAGE_MISSING`` (Req 9.3) -- same
  status, different code, because the frontend renders a missing thumbnail rather
  than "no such entry" for the second.
* **Every filename goes through the containment gate.** The name comes out of the
  database, but :func:`app.services.storage.safe_upload_path` is still the only way
  a path is built from it (Req 4.6). Trusting the database because "we wrote it"
  is how a traversal survives a round trip through storage.

Stored images are immutable -- the filename is a uuid4, so those bytes never
change -- which is why the image route can send
``Cache-Control: private, max-age=31536000, immutable``. ``private`` because the
image is one user's uploaded photo and no shared cache should hold it.

Out-of-range ``limit`` / ``offset`` are the one place FastAPI's own validation is
the right tool: the constraints are declared on the ``Query`` parameters and the
app-level ``RequestValidationError`` handler renders them in the standard envelope
as ``422 INVALID_QUERY``.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Path, Query, Response, status
from fastapi.responses import FileResponse

from ..config import Settings
from ..db.repository import DEFAULT_LIMIT, ScanRecord, ScanRepository
from ..dependencies import get_app_settings, get_repository, get_store
from ..errors import ImageMissingError, NotFoundError
from ..logging_config import get_logger
from ..schemas import (
    CandidateOut,
    ErrorResponse,
    HistoryItemOut,
    HistoryListResponse,
    RecommendationOut,
    ScanDetailResponse,
)
from ..services.label_resolver import PLACEHOLDER, STAGE_PLACEHOLDER
from ..services.recommendations import RecommendationStore, RecommendationView
from ..services.storage import EXT_BY_FORMAT, safe_upload_path

__all__ = [
    "router",
    "IMAGE_CACHE_CONTROL",
    "MAX_LIMIT",
    "MEDIA_TYPE_BY_EXT",
    "media_type_for",
    "to_item",
    "to_detail",
    "recommendation_for",
]

log = get_logger(__name__)

router = APIRouter(tags=["history"])

MAX_LIMIT = 200
"""Largest page the API will serve. ``limit`` is validated as 1..200."""

IMAGE_CACHE_CONTROL = "private, max-age=31536000, immutable"
"""One year, immutable, and never in a shared cache: the name is a uuid4, the bytes
are one user's photo."""

MEDIA_TYPE_BY_EXT: dict[str, str] = {
    ext: f"image/{fmt.lower()}" for fmt, ext in EXT_BY_FORMAT.items()
}
"""``.jpg -> image/jpeg``, derived from storage's format table rather than restated,
so adding an accepted format in one place cannot leave the other behind."""

_FALLBACK_MEDIA_TYPE = "application/octet-stream"


def media_type_for(filename: str) -> str:
    """Media type implied by a stored filename's extension.

    The extension was written by :func:`app.services.storage.store_image` from the
    *sniffed* format, so it describes the bytes rather than whatever the client
    claimed. An unknown extension cannot reach here through
    :func:`~app.services.storage.safe_upload_path`, but it degrades to
    ``application/octet-stream`` rather than raising.
    """
    dot = filename.rfind(".")
    if dot < 0:
        return _FALLBACK_MEDIA_TYPE
    return MEDIA_TYPE_BY_EXT.get(filename[dot:].lower(), _FALLBACK_MEDIA_TYPE)


def to_item(record: ScanRecord) -> HistoryItemOut:
    """Project one stored scan into its history-list shape (Req 9.7)."""
    return HistoryItemOut(
        id=record.id,
        image_url=f"/api/history/{record.id}/image",
        display_name=record.display_name,
        crop=record.crop,
        crop_hindi=record.crop_hindi,
        disease=record.disease,
        confidence=record.confidence,
        model_used=record.model_used,
        is_uncertain=record.is_uncertain,
        is_healthy=record.is_healthy,
        created_at=record.created_at,
    )


def recommendation_for(
    record: ScanRecord,
    store: RecommendationStore,
) -> RecommendationOut:
    """Rebuild one scan's guidance block from its stored ``recommendation_key``.

    The key and the resolution stage are what the row keeps; the guidance itself is
    never duplicated into the database, so a data-file correction reaches old scans
    for free. That is the whole reason the detail route resolves rather than stores.

    A ``NULL`` key means the label resolved to the placeholder when the scan was
    made (Req 7.8), and a key the store no longer holds means the data files
    changed under it -- the second is logged, both project to the placeholder
    record with ``is_placeholder=True``, which is byte-identical to what
    ``POST /api/predict`` returns in the same situation. One recommendation shape
    for the frontend, always.
    """
    key = record.recommendation_key
    if key:
        view = store.view(key, resolution_stage=record.resolution_stage or "exact")
        if view is not None:
            return view.to_out()
        log.warning(
            "scan %s cites recommendation key %r, which the store no longer holds; "
            "serving the placeholder",
            record.id,
            key,
        )

    return RecommendationView.of(
        PLACEHOLDER, source_key=None, resolution_stage=STAGE_PLACEHOLDER
    ).to_out()


def to_detail(record: ScanRecord, store: RecommendationStore) -> ScanDetailResponse:
    """Project one stored scan into the detail shape: the list row plus the two blocks.

    ``candidates`` comes back out of ``candidates_json`` exactly as it was stored --
    the winning model's top-3, never re-run and never re-scored.
    """
    return ScanDetailResponse(
        **to_item(record).model_dump(exclude={"confidence_percent"}),
        candidates=[
            CandidateOut(
                label=candidate.label,
                display_name=candidate.display_name,
                confidence=candidate.confidence,
            )
            for candidate in record.candidates
        ],
        recommendation=recommendation_for(record, store),
    )


@router.get(
    "/history",
    response_model=HistoryListResponse,
    summary="List saved scans, newest first",
    responses={422: {"model": ErrorResponse}, 500: {"model": ErrorResponse}},
)
def list_history(
    limit: int = Query(DEFAULT_LIMIT, ge=1, le=MAX_LIMIT, description="Page size, 1-200"),
    offset: int = Query(0, ge=0, description="Rows to skip"),
    repository: ScanRepository = Depends(get_repository),
) -> HistoryListResponse:
    """One page of scan history, newest first (Req 9.2).

    ``total`` is the unpaged row count, so the UI can page without a second call.
    """
    records = repository.list(limit=limit, offset=offset)
    return HistoryListResponse(
        total=repository.count(),
        limit=limit,
        offset=offset,
        items=[to_item(record) for record in records],
    )


@router.get(
    "/history/{scan_id}",
    response_model=ScanDetailResponse,
    summary="One saved scan in full, with its candidates and guidance",
    responses={
        404: {"model": ErrorResponse, "description": "Unknown scan"},
        500: {"model": ErrorResponse},
    },
)
def get_history_detail(
    scan_id: str = Path(description="Scan id from a history entry"),
    repository: ScanRepository = Depends(get_repository),
    store: RecommendationStore = Depends(get_store),
) -> ScanDetailResponse:
    """The complete stored result for one scan: the detail modal and report source.

    Everything the list row carries, plus the stored top-3 candidates and the
    recommendation resolved from the row's ``recommendation_key``. No inference and
    no image read happen here.

    Raises:
        NotFoundError: no row with that id (404 ``NOT_FOUND``).
    """
    record = repository.get(scan_id)
    if record is None:
        log.info("history detail requested for unknown scan %r", scan_id)
        raise NotFoundError

    return to_detail(record, store)


@router.get(
    "/history/{scan_id}/image",
    response_class=FileResponse,
    summary="The stored image for one scan",
    responses={
        200: {"content": {"image/jpeg": {}, "image/png": {}, "image/webp": {}}},
        400: {"model": ErrorResponse},
        404: {"model": ErrorResponse, "description": "Unknown scan, or its image is gone"},
        500: {"model": ErrorResponse},
    },
)
def get_history_image(
    scan_id: str = Path(description="Scan id from a history entry"),
    repository: ScanRepository = Depends(get_repository),
    settings: Settings = Depends(get_app_settings),
) -> FileResponse:
    """Serve one scan's stored bytes.

    Raises:
        NotFoundError: no row with that id (404 ``NOT_FOUND``, Req 9.9).
        ImageMissingError: the row exists but the file does not (404
            ``IMAGE_MISSING``, Req 9.3).
        BadRequestError: the stored filename fails the containment gate (400,
            Req 4.6).
    """
    record = repository.get(scan_id)
    if record is None:
        log.info("history image requested for unknown scan %r", scan_id)
        raise NotFoundError

    path = safe_upload_path(record.image_filename, settings)
    if not path.is_file():
        log.warning("scan %s references %s, which is not on disk", scan_id, path.name)
        raise ImageMissingError

    return FileResponse(
        path,
        media_type=media_type_for(record.image_filename),
        headers={"Cache-Control": IMAGE_CACHE_CONTROL},
    )


@router.delete(
    "/history",
    status_code=status.HTTP_204_NO_CONTENT,
    response_class=Response,
    summary="Delete all scans and their images",
    responses={
        204: {"description": "All history deleted"},
        500: {"model": ErrorResponse},
    },
)
def delete_all_history(
    repository: ScanRepository = Depends(get_repository),
) -> Response:
    """Delete all scans and unlink all associated images."""
    count = repository.delete_all()
    log.info("deleted all scans (%d rows and images removed)", count)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.delete(
    "/history/{scan_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    response_class=Response,
    summary="Delete one scan and its image",
    responses={
        204: {"description": "Deleted"},
        404: {"model": ErrorResponse, "description": "Unknown scan"},
        500: {"model": ErrorResponse},
    },
)
def delete_history_entry(
    scan_id: str = Path(description="Scan id from a history entry"),
    repository: ScanRepository = Depends(get_repository),
) -> Response:
    """Delete a scan: the row first, then its image (Req 9.8, 9.9).

    The repository owns that ordering. A crash between the two steps leaves an
    orphaned file, which the startup sweep names, rather than a history row
    pointing at nothing.

    Raises:
        NotFoundError: no row with that id (404, Req 9.9).
    """
    if not repository.delete(scan_id):
        log.info("delete requested for unknown scan %r", scan_id)
        raise NotFoundError

    log.info("deleted scan %s", scan_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
