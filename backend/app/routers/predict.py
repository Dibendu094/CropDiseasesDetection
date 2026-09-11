"""``POST /api/predict`` -- the one write path in the API.

Two declarations in this module carry more weight than they look like they do.

**The file part is optional at the framework level.** ``file: UploadFile | None =
File(default=None)`` is what keeps FastAPI's own ``422`` out of the way: a required
``File(...)`` would have the framework reject a fileless request before any of this
code ran, and Requirement 10.1 asks for ``400 IMAGE_REQUIRED``. Declaring it
optional hands the decision to
:func:`app.services.storage.read_upload_bytes`, which raises
:class:`~app.errors.MissingImageError`.

**The ``crop`` part is optional and additive.** ``crop: str | None =
Form(default=None)`` is a pure addition: omit it and this route behaves exactly as
it did before it existed. Supply it and the cascade restricts each model's softmax
to that crop's classes, renormalising over them, so the reported confidence is a
probability within the crop. The masking itself lives in
:mod:`app.services.inference` (see ``allowed_indices``), not here; this module only
forwards the string and reports back the crop that was actually applied as
``meta.crop_filter``.

**The split between async and sync is deliberate.** Reading the upload is async
(``UploadFile.read`` is a coroutine, and the size gate has to run *while* the body
streams so a 2 GB post costs 10 MB of memory). Everything after that is
CPU-and-blocking-IO: Pillow decode, two possible forward passes, a file write, a
SQLite insert. So the request is served in two pieces:

* an **async dependency**, :func:`read_upload_body`, which streams the body under
  the byte cap and hands on plain ``bytes``;
* a **sync ``def`` handler**, which FastAPI therefore runs in its worker
  threadpool, where blocking work belongs and where the ``get_connection``
  dependency's SQLite connection lives.

The alternative -- an ``async def`` handler wrapping the blocking half in
``run_in_threadpool`` -- would have worked too, but it would put the request's
SQLite connection and its user on opposite sides of a thread boundary, and
``sqlite3`` objects are checked against their creating thread. This way the
connection is created, used and closed on the same threadpool worker.

The write order is: validate, infer, resolve, **then** store and insert. Nothing
touches the disk until a diagnosis exists, so a rejected upload leaves no file
behind (Req 4.4), and if the insert fails the freshly written image is removed
rather than orphaned.
"""

from __future__ import annotations

import time
import uuid
from dataclasses import dataclass

from fastapi import APIRouter, Depends, File, Form, UploadFile, status

from ..config import Settings
from ..db.repository import ScanCandidate, ScanRecord, ScanRepository, utc_now_iso
from ..dependencies import (
    get_app_settings,
    get_crop_index,
    get_registry,
    get_repository,
    get_resolver,
)
from ..logging_config import get_logger
from ..schemas import (
    CandidateOut,
    DiagnosisOut,
    ErrorResponse,
    PredictMetaOut,
    PredictResponse,
)
from ..services.crop_index import CropIndex
from ..services.inference import describe_candidates, predict
from ..services.label_resolver import LabelResolver
from ..services.model_registry import ModelRegistry
from ..services.storage import delete_image, store_validated, validate_image_bytes

__all__ = ["router", "UploadBody", "read_upload_body", "image_url_for"]

log = get_logger(__name__)

router = APIRouter(tags=["predict"])


def image_url_for(scan_id: str) -> str:
    """The relative URL the history image route serves this scan's bytes from."""
    return f"/api/history/{scan_id}/image"


@dataclass(frozen=True, slots=True)
class UploadBody:
    """The upload as bytes, plus the media type the client declared.

    The declared content type is carried forward because it never *admits* a file
    -- it only decides whether unrecognised bytes are reported as an unsupported
    format (415) or a broken image (422). See
    :func:`app.services.storage.sniff_format`.
    """

    data: bytes
    content_type: str | None


async def read_upload_body(
    file: UploadFile | None = File(default=None),
    settings: Settings = Depends(get_app_settings),
) -> UploadBody:
    """Stream the ``file`` part under the byte cap (validation gates 1 and 2).

    Async because ``UploadFile.read`` is, and because the size gate must fire
    mid-stream rather than after the whole body is buffered.

    Raises:
        MissingImageError: no ``file`` part, or an empty one (400, Req 10.1).
        PayloadTooLargeError: the body passed ``max_upload_bytes`` (413, Req 4.3).
    """
    # Imported here rather than at module scope so the dependency and the handler
    # read as the two halves of one pipeline.
    from ..services.storage import read_upload_bytes  # noqa: PLC0415

    data = await read_upload_bytes(file, settings)
    return UploadBody(data=data, content_type=getattr(file, "content_type", None))


@router.post(
    "/predict",
    response_model=PredictResponse,
    status_code=status.HTTP_200_OK,
    summary="Diagnose a crop leaf image",
    responses={
        400: {"model": ErrorResponse, "description": "No image attached"},
        413: {"model": ErrorResponse, "description": "Image larger than the upload cap"},
        415: {"model": ErrorResponse, "description": "Format not accepted"},
        422: {"model": ErrorResponse, "description": "Image could not be read"},
        500: {"model": ErrorResponse},
        503: {"model": ErrorResponse, "description": "No model is loaded"},
    },
)
def predict_image(
    body: UploadBody = Depends(read_upload_body),
    crop: str | None = Form(
        default=None,
        description=(
            "Optional crop hint. Any spelling of a known crop -- 'Corn (Maize)', "
            "'corn_maize' and 'corn' all match. Restricts the prediction to that "
            "crop's classes; an unknown crop is ignored."
        ),
    ),
    registry: ModelRegistry = Depends(get_registry),
    resolver: LabelResolver = Depends(get_resolver),
    crop_index: CropIndex = Depends(get_crop_index),
    repository: ScanRepository = Depends(get_repository),
    settings: Settings = Depends(get_app_settings),
) -> PredictResponse:
    """Run one image through the cascade, persist the result, and return it.

    Sync ``def`` on purpose: FastAPI runs it in a worker thread, which is where the
    Pillow decode, the forward passes, the file write and the SQLite insert all
    belong. The bytes were already read by :func:`read_upload_body`.

    ``crop`` is an optional form field, so a request that omits it is handled
    exactly as it was before the field existed. When it is present the cascade
    masks each model's softmax to that crop's classes; the decision of *whether* a
    hint can be honoured belongs to :func:`app.services.inference.predict`, not
    here, which is why this handler passes the raw string straight through and
    reads back what was actually applied as ``prediction.crop_filter``.

    Raises:
        UnsupportedMediaTypeError: 415. UnreadableImageError: 422.
        ServiceUnavailableError: 503, no model is loaded (Req 10.5).
    """
    # Gates 3-4: magic-byte sniff and a real decode. One decode for the whole
    # request -- the cascade reuses this PIL image for both models.
    validated = validate_image_bytes(body.data, body.content_type, settings)

    started = time.perf_counter()
    prediction = predict(
        validated.image, registry, settings, crop=crop, crop_index=crop_index
    )
    inference_ms = int(round((time.perf_counter() - started) * 1000))

    resolution, display_name = resolver.resolve_with_display_name(
        prediction.label, prediction.model_used
    )
    record = resolution.record
    candidates = [
        CandidateOut(label=label, display_name=name, confidence=confidence)
        for label, name, confidence in describe_candidates(
            prediction.candidates, resolver, prediction.model_used
        )
    ]

    scan_id = uuid.uuid4().hex
    created_at = utc_now_iso()
    stored = store_validated(validated, settings)

    scan = ScanRecord(
        id=scan_id,
        image_filename=stored.filename,
        label=prediction.label,
        recommendation_key=resolution.key,
        resolution_stage=resolution.stage,
        display_name=display_name,
        crop=record.crop,
        crop_hindi=record.crop_hindi,
        disease=record.disease,
        confidence=prediction.confidence,
        model_used=prediction.model_used,
        is_uncertain=prediction.is_uncertain,
        is_healthy=record.is_healthy,
        candidates=tuple(
            ScanCandidate(
                label=candidate.label,
                display_name=candidate.display_name,
                confidence=candidate.confidence,
            )
            for candidate in candidates
        ),
        created_at=created_at,
    )

    try:
        repository.insert(scan)
    except Exception:
        # The image is on disk but no row points at it. Remove it now rather than
        # leave an orphan for the startup sweep to report.
        log.exception("insert failed for scan %s; removing the stored image", scan_id)
        delete_image(stored.filename, settings)
        raise

    log.info(
        "scan %s: %s %.4f via %s (stage=%s, models_run=%s, crop_filter=%s, %d ms)",
        scan_id,
        prediction.label,
        prediction.confidence,
        prediction.model_used,
        resolution.stage,
        ",".join(prediction.models_run),
        prediction.crop_filter or "-",
        inference_ms,
    )

    return PredictResponse(
        scan_id=scan_id,
        image_url=image_url_for(scan_id),
        created_at=created_at,
        diagnosis=DiagnosisOut(
            label=prediction.label,
            display_name=display_name,
            crop=record.crop,
            crop_hindi=record.crop_hindi,
            disease=record.disease,
            is_healthy=record.is_healthy,
            confidence=prediction.confidence,
            model_used=prediction.model_used,
            is_uncertain=prediction.is_uncertain,
        ),
        candidates=candidates,
        recommendation=resolution.view().to_out(),
        meta=PredictMetaOut(
            models_run=list(prediction.models_run),
            confidence_threshold=float(settings.confidence_threshold),
            inference_ms=inference_ms,
            crop_filter=prediction.crop_filter,
        ),
    )
