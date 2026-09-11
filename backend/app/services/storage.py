"""Upload validation and bounded image storage (Req 4.1-4.6, 10.1-10.2).

Validation runs in **one fixed order**, and the order is the contract: every
rejection maps to exactly one status code, and no two gates can claim the same
failure.

===  ==============  =========================================================
#    gate            failure
===  ==============  =========================================================
1    presence        :class:`MissingImageError` -> ``400``
2    size            :class:`PayloadTooLargeError` -> ``413``
3    magic bytes     :class:`UnsupportedMediaTypeError` -> ``415``
                     (or ``422`` when the client declared ``image/*``)
4    decode          :class:`UnreadableImageError` -> ``422``
5    persist         -- runs only after gate 4 succeeds
===  ==============  =========================================================

Consequences of that ordering worth stating outright:

* **Size is checked before anything is parsed.** The stream is consumed in
  64 KiB chunks and abandoned the moment the accumulated length passes
  ``max_upload_bytes``, so a 2 GB body costs 10 MB of memory, not 2 GB.
  ``Content-Length`` is a client-supplied number and is never consulted.
* **Unrecognised bytes are 415, not 422 -- unless the client said otherwise.**
  A file with no image signature at all is "not an image format we accept"
  (415). But if the request declared ``content-type: image/jpeg``, the client
  asserted it *is* an image, so the honest answer is "you sent an image and it
  is broken" (422). This is the only place the declared content type influences
  a decision; it is never trusted to *admit* a file.
* **Nothing is written until the decode succeeds.** A rejected upload leaves no
  file behind, so the uploads directory cannot be used as a drop box for bytes
  that were never a valid image.
* **The client filename is discarded entirely.** The stored name is
  ``<uuid4 hex><ext>`` where ``ext`` comes from the *sniffed* format, so
  ``evil.php.jpg`` becomes ``3f2b....jpg`` and the original name is never
  written to disk or to the database.

:func:`safe_upload_path` is the single chokepoint for every read, write and
delete. It applies three independent gates -- basename equality, a strict
``^[0-9a-f]{32}\\.(jpg|png|webp)$`` regex, and a post-``resolve()`` containment
check -- because each catches a different trick: ``../``, ``..\\``, absolute
POSIX paths, drive-relative Windows paths, UNC ``\\\\host\\share``, separators a
proxy URL-decoded, NUL bytes, and symlinks that resolve outside the root.
"""

from __future__ import annotations

import io
import re
import uuid
import warnings
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from PIL import Image, UnidentifiedImageError

from ..config import Settings, get_settings
from ..errors import (
    BadRequestError,
    MissingImageError,
    PayloadTooLargeError,
    UnreadableImageError,
    UnsupportedMediaTypeError,
)
from ..logging_config import get_logger
from .preprocess import decode_image

__all__ = [
    "EXT_BY_FORMAT",
    "UPLOAD_CHUNK_SIZE",
    "UPLOAD_NAME_RE",
    "StoredImage",
    "UploadLike",
    "ValidatedUpload",
    "delete_image",
    "read_upload_bytes",
    "safe_upload_path",
    "sniff_format",
    "store_image",
    "store_validated",
    "validate_image_bytes",
    "validate_upload",
]

log = get_logger(__name__)

UPLOAD_CHUNK_SIZE = 64 * 1024
"""Stream granularity for the size gate. Small enough that the overshoot past
``max_upload_bytes`` before the abort is bounded by 64 KiB."""

EXT_BY_FORMAT: dict[str, str] = {"JPEG": ".jpg", "PNG": ".png", "WEBP": ".webp"}
"""Sniffed format -> stored extension. The only source of a file extension."""

UPLOAD_NAME_RE = re.compile(r"^[0-9a-f]{32}\.(jpg|png|webp)$")
"""Exactly what :func:`store_image` produces: a uuid4 hex and one of three
extensions. Anchored, lower-case only, no dots or separators anywhere else."""

# --- container signatures --------------------------------------------------
# Accepted formats. WebP is a RIFF container: "RIFF" ....(size) "WEBP".
_JPEG_MAGIC = b"\xff\xd8\xff"
_PNG_MAGIC = b"\x89PNG\r\n\x1a\n"
_RIFF_MAGIC = b"RIFF"
_WEBP_TAG = b"WEBP"

# Real image formats we can often decode but deliberately do not accept. Named
# individually so the log line says *which* format was refused, which is the
# difference between a debuggable 415 and a mystery.
_REJECTED_PREFIXES: tuple[tuple[bytes, str], ...] = (
    (b"GIF87a", "GIF"),
    (b"GIF89a", "GIF"),
    (b"BM", "BMP"),
    (b"II*\x00", "TIFF"),
    (b"MM\x00*", "TIFF"),
    (b"\x00\x00\x01\x00", "ICO"),
    (b"\x00\x00\x02\x00", "CUR"),
    (b"8BPS", "PSD"),
    (b"\x00\x00\x00\x0cjP  ", "JPEG2000"),
)

# ISO-BMFF brands, read at offset 8 when bytes 4:8 are "ftyp". HEIC and AVIF are
# what a modern iPhone or Android camera produces, so this branch is common
# enough that its 415 message matters (Req 4.2).
_FTYP_BRANDS: dict[bytes, str] = {
    b"heic": "HEIC",
    b"heix": "HEIC",
    b"hevc": "HEIC",
    b"hevx": "HEIC",
    b"heim": "HEIC",
    b"heis": "HEIC",
    b"hevm": "HEIC",
    b"hevs": "HEIC",
    b"mif1": "HEIF",
    b"msf1": "HEIF",
    b"avif": "AVIF",
    b"avis": "AVIF",
}

_HEADER_BYTES = 16
"""Enough for every signature above: the longest check reads bytes 8:12."""


class UploadLike(Protocol):
    """The slice of Starlette's ``UploadFile`` this module depends on.

    Declaring it structurally keeps the module importable -- and testable --
    without FastAPI installed, and lets tests hand in a two-method stand-in.
    """

    filename: str | None
    content_type: str | None

    async def read(self, size: int = -1) -> bytes:
        """Return at most ``size`` bytes, or ``b""`` at end of stream."""


@dataclass(frozen=True, slots=True)
class ValidatedUpload:
    """An upload that cleared all four validation gates but is not yet on disk.

    Carries the decoded image so the caller does not pay for a second decode:
    the inference path feeds ``image`` straight to
    :func:`app.services.preprocess.to_tensors`, and :func:`store_image` writes
    ``data`` unchanged -- the bytes on disk are the bytes the client sent.
    """

    data: bytes
    fmt: str
    image: Image.Image

    @property
    def ext(self) -> str:
        """Extension implied by the sniffed format (``".jpg"``, not the client's)."""
        return EXT_BY_FORMAT[self.fmt]

    @property
    def size(self) -> int:
        return len(self.data)


@dataclass(frozen=True, slots=True)
class StoredImage:
    """Result of persisting a validated upload."""

    filename: str
    path: Path
    fmt: str
    size: int


# --- gate 1 + 2: presence and size ----------------------------------------


async def read_upload_bytes(
    file: UploadLike | None,
    settings: Settings | None = None,
) -> bytes:
    """Stream an ``UploadFile`` into memory under a hard byte cap (gates 1-2).

    Args:
        file: the ``UploadFile`` FastAPI bound to the ``file`` form part, or
            ``None`` when the part was absent. The route declares it
            ``UploadFile | None = File(default=None)`` precisely so that this
            function -- not FastAPI's own 422 -- decides what a missing file
            means.
        settings: defaults to the process settings.

    Returns:
        The complete upload bytes.

    Raises:
        MissingImageError: no file part, or a part carrying zero bytes -- both
            mean "no image was attached" (400, Req 10.1).
        PayloadTooLargeError: the accumulated length passed
            ``max_upload_bytes``; raised mid-stream, before the rest of the body
            is read (413, Req 4.3).
    """
    settings = settings or get_settings()
    if file is None:
        log.info("upload rejected: no file part in request")
        raise MissingImageError

    limit = int(settings.max_upload_bytes)
    chunks: list[bytes] = []
    total = 0

    while True:
        chunk = await file.read(UPLOAD_CHUNK_SIZE)
        if not chunk:
            break
        total += len(chunk)
        if total > limit:
            # Abort here. Returning without draining the stream is what keeps a
            # hostile body from being buffered in full; the ASGI server discards
            # the remainder when the response is sent.
            log.info("upload rejected: exceeded %d bytes (read %d)", limit, total)
            raise PayloadTooLargeError
        chunks.append(chunk)

    if total == 0:
        # An attached-but-empty part is indistinguishable from no image, and
        # "attach a photo and try again" is the useful thing to say.
        log.info("upload rejected: empty file part")
        raise MissingImageError

    return b"".join(chunks)


# --- gate 3: magic-byte sniff ---------------------------------------------


def sniff_format(data: bytes, content_type: str | None = None) -> str:
    """Identify the container from its leading bytes (gate 3).

    The declared ``content-type`` never admits a file. It only decides how an
    *unrecognised* one is reported: a client that said ``image/*`` claims to
    have sent an image, so unrecognised bytes are a broken image (422) rather
    than an unsupported format (415).

    Args:
        data: the upload bytes; only the first 16 are inspected.
        content_type: the client-declared media type, if any. Parameters such as
            ``; charset=...`` are ignored.

    Returns:
        ``"JPEG"``, ``"PNG"`` or ``"WEBP"``.

    Raises:
        UnsupportedMediaTypeError: a recognised but unaccepted image format
            (GIF, BMP, TIFF, HEIC, AVIF, ...), or bytes with no image signature
            and no ``image/*`` declaration (415, Req 4.2).
        UnreadableImageError: bytes with no image signature from a client that
            declared ``image/*`` (422, Req 10.2).
    """
    header = bytes(data[:_HEADER_BYTES])

    if header.startswith(_JPEG_MAGIC):
        return "JPEG"
    if header.startswith(_PNG_MAGIC):
        return "PNG"
    if header.startswith(_RIFF_MAGIC) and header[8:12] == _WEBP_TAG:
        return "WEBP"

    for prefix, name in _REJECTED_PREFIXES:
        if header.startswith(prefix):
            log.info("upload rejected: %s is not an accepted format", name)
            raise UnsupportedMediaTypeError

    if header[4:8] == b"ftyp":
        brand = _FTYP_BRANDS.get(header[8:12].lower())
        if brand is not None:
            log.info("upload rejected: %s is not an accepted format", brand)
            raise UnsupportedMediaTypeError

    if _declares_image(content_type):
        log.info(
            "upload rejected: content-type %r claims an image but bytes are unrecognised",
            content_type,
        )
        raise UnreadableImageError

    log.info("upload rejected: no recognised image signature (content-type %r)", content_type)
    raise UnsupportedMediaTypeError


def _declares_image(content_type: str | None) -> bool:
    """True when the client declared an ``image/...`` media type."""
    if not content_type:
        return False
    return content_type.split(";", 1)[0].strip().lower().startswith("image/")


# --- gate 4: decode -------------------------------------------------------


def _decode_or_reject(data: bytes) -> Image.Image:
    """``verify()`` then a full ``load()``, both mapped to 422.

    Two passes because they catch different things and Pillow forbids reusing an
    image after ``verify()``:

    * ``verify()`` checks structural integrity (chunk CRCs in a PNG, for
      instance) without decoding pixels.
    * a reopen plus ``load()`` forces the actual pixel decode, which is where a
      truncated JPEG finally fails.

    ``MAX_IMAGE_PIXELS`` is left at Pillow's default; the warning it raises at
    the threshold is escalated to an error here so a decompression bomb is
    *rejected* rather than decoded into resident memory.
    """
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(data)) as probe:
                probe.verify()
            # decode_image() reopens and load()s, and already maps
            # UnidentifiedImageError / OSError / ValueError / SyntaxError to
            # UnreadableImageError. Reused rather than reimplemented so there is
            # one decode policy in the codebase.
            return decode_image(data)
    except (Image.DecompressionBombError, Image.DecompressionBombWarning) as exc:
        log.warning("upload rejected: decompression bomb (%s)", type(exc).__name__)
        raise UnreadableImageError from exc
    except (UnidentifiedImageError, OSError, ValueError, SyntaxError) as exc:
        log.info("upload rejected: verify failed: %s: %s", type(exc).__name__, exc)
        raise UnreadableImageError from exc


# --- gates 1-4 as one call ------------------------------------------------


def validate_image_bytes(
    data: bytes,
    content_type: str | None = None,
    settings: Settings | None = None,
) -> ValidatedUpload:
    """Run gates 1-4 over bytes already in memory (the sync, FastAPI-free path).

    Args:
        data: the upload bytes. ``None`` or empty is treated as "no image".
        content_type: the client-declared media type, if any.
        settings: defaults to the process settings.

    Returns:
        A :class:`ValidatedUpload` holding the original bytes, the sniffed
        format, and the decoded image. Nothing has been written to disk.

    Raises:
        MissingImageError: 400. PayloadTooLargeError: 413.
        UnsupportedMediaTypeError: 415. UnreadableImageError: 422.
    """
    settings = settings or get_settings()

    if not data:
        log.info("upload rejected: empty payload")
        raise MissingImageError

    payload = bytes(data)
    if len(payload) > int(settings.max_upload_bytes):
        log.info(
            "upload rejected: %d bytes exceeds %d", len(payload), settings.max_upload_bytes
        )
        raise PayloadTooLargeError

    fmt = sniff_format(payload, content_type)
    if fmt not in settings.allowed_formats or fmt not in EXT_BY_FORMAT:
        # Only reachable if allowed_formats was narrowed by configuration.
        log.info("upload rejected: %s is not in allowed_formats", fmt)
        raise UnsupportedMediaTypeError

    image = _decode_or_reject(payload)

    decoded_fmt = (image.format or fmt).upper()
    if decoded_fmt != fmt:
        # The signature and the decoder disagree: a container claiming to be
        # WebP that Pillow reads as something else. Trust neither, refuse.
        log.info("upload rejected: sniffed %s but decoded %s", fmt, decoded_fmt)
        raise UnsupportedMediaTypeError

    log.debug("upload accepted: %s %dx%d %d bytes", fmt, *image.size, len(payload))
    return ValidatedUpload(data=payload, fmt=fmt, image=image)


async def validate_upload(
    file: UploadLike | None,
    settings: Settings | None = None,
) -> ValidatedUpload:
    """Run gates 1-4 over a FastAPI ``UploadFile`` (the async path).

    The size gate happens while the body is still streaming
    (:func:`read_upload_bytes`), so an oversize upload is refused without ever
    being buffered in full.

    Args:
        file: the bound ``UploadFile``, or ``None`` when the part was absent.
        settings: defaults to the process settings.

    Returns:
        A :class:`ValidatedUpload`. Nothing has been written to disk yet --
        :func:`store_image` is a separate, later step by design.

    Raises:
        MissingImageError: 400. PayloadTooLargeError: 413.
        UnsupportedMediaTypeError: 415. UnreadableImageError: 422.
    """
    settings = settings or get_settings()
    data = await read_upload_bytes(file, settings)
    declared = getattr(file, "content_type", None)
    return validate_image_bytes(data, declared, settings)


# --- gate 5: persist ------------------------------------------------------


def store_image(data: bytes, fmt: str, settings: Settings | None = None) -> str:
    """Write validated bytes under a server-generated name (Req 4.5).

    Called only after :func:`validate_image_bytes` has succeeded, which is what
    guarantees a rejected upload never leaves a file behind.

    Args:
        data: the exact bytes to persist -- unmodified, so the stored file is
            byte-identical to what the client sent.
        fmt: the *sniffed* format. The extension is derived from this and never
            from the client filename, which is discarded entirely.
        settings: defaults to the process settings.

    Returns:
        The generated filename, e.g. ``"3f2b...c1.jpg"``. This is the only
        handle to the file; it is what goes into the database.

    Raises:
        UnsupportedMediaTypeError: ``fmt`` has no accepted extension.
        OSError: the write failed.
    """
    settings = settings or get_settings()
    key = str(fmt).upper()
    ext = EXT_BY_FORMAT.get(key)
    if ext is None:
        log.error("refusing to store unknown format %r", fmt)
        raise UnsupportedMediaTypeError

    settings.uploads_dir.mkdir(parents=True, exist_ok=True)
    filename = f"{uuid.uuid4().hex}{ext}"
    path = safe_upload_path(filename, settings)
    path.write_bytes(bytes(data))
    log.info("stored upload %s (%s, %d bytes)", filename, key, len(data))
    return filename


def store_validated(
    validated: ValidatedUpload,
    settings: Settings | None = None,
) -> StoredImage:
    """Persist a :class:`ValidatedUpload` and describe where it landed."""
    settings = settings or get_settings()
    filename = store_image(validated.data, validated.fmt, settings)
    return StoredImage(
        filename=filename,
        path=safe_upload_path(filename, settings),
        fmt=validated.fmt,
        size=validated.size,
    )


# --- path containment (Req 4.6) ------------------------------------------


def safe_upload_path(filename: str, settings: Settings | None = None) -> Path:
    """Resolve ``filename`` inside the uploads directory, or refuse (Req 4.6).

    Every read, write and delete of an upload goes through here. Three
    independent gates, because each stops a different class of trick:

    1. **basename equality** -- ``filename != Path(filename).name`` rejects any
       separator or ``..`` segment the current platform understands, including
       ``../``, ``..\\``, ``/etc/passwd``, ``C:\\Windows\\win.ini``,
       ``\\\\host\\share\\x`` and ``<uuid>.jpg/../..``.
    2. **strict regex** -- :data:`UPLOAD_NAME_RE` admits only what
       :func:`store_image` generates. This is the gate that catches NUL bytes,
       percent-encoded separators a proxy may have decoded (``%2e%2e%2f``),
       upper-case drive letters, and anything else exotic, on *every* platform
       rather than only the one whose path syntax matches.
    3. **containment after resolve()** -- the final check, so that a symlink or
       a junction inside the uploads directory cannot point outside it.

    Args:
        filename: a stored upload name. In production it arrives from a database
            row, so a traversal string has to survive the lookup *and* these
            gates.
        settings: defaults to the process settings.

    Returns:
        The absolute path to the file. Existence is not implied -- callers that
        need it report :class:`app.errors.ImageMissingError` themselves.

    Raises:
        BadRequestError: any gate rejected the name (400).
    """
    settings = settings or get_settings()

    if not isinstance(filename, str) or not filename:
        raise BadRequestError

    # Gate 1: basename equality.
    try:
        basename = Path(filename).name
    except (ValueError, OSError) as exc:  # embedded NUL on some platforms
        log.warning("rejected image reference: unusable as a path")
        raise BadRequestError from exc
    if filename != basename:
        log.warning("rejected image reference: not a bare basename")
        raise BadRequestError

    # Gate 2: strict name shape.
    if UPLOAD_NAME_RE.fullmatch(filename) is None:
        log.warning("rejected image reference: does not match the stored-name pattern")
        raise BadRequestError

    # Gate 3: containment after resolution.
    root = _uploads_root(settings)
    expected = root / filename
    try:
        candidate = expected.resolve()
    except (ValueError, OSError) as exc:  # pragma: no cover - platform dependent
        log.warning("rejected image reference: could not be resolved")
        raise BadRequestError from exc

    if candidate != expected or root != candidate.parent:
        # resolve() moved the path: a symlink or junction inside the uploads
        # directory pointing elsewhere. Refuse rather than follow it.
        log.warning("rejected image reference: resolves outside the uploads directory")
        raise BadRequestError

    return candidate


def _uploads_root(settings: Settings) -> Path:
    """The resolved uploads directory.

    ``Settings`` already resolves ``uploads_dir``; resolving again picks up a
    symlinked root so that gate 3 compares like with like. A missing directory
    is not an error here -- a read of a not-yet-created uploads directory should
    report a missing *image*, not a bad request.
    """
    try:
        return settings.uploads_dir.resolve()
    except (ValueError, OSError):  # pragma: no cover - platform dependent
        return Path(settings.uploads_dir)


def delete_image(filename: str, settings: Settings | None = None) -> bool:
    """Delete a stored upload, through the same containment gate.

    Args:
        filename: the stored name.
        settings: defaults to the process settings.

    Returns:
        ``True`` if a file was removed, ``False`` if it was already gone --
        deletion is idempotent, so a repeated history delete is not an error.

    Raises:
        BadRequestError: ``filename`` failed :func:`safe_upload_path` (400).
    """
    path = safe_upload_path(filename, settings)
    try:
        path.unlink()
    except FileNotFoundError:
        log.info("delete skipped, file already absent: %s", filename)
        return False
    except OSError:
        # A locked or permission-denied file must not sink the surrounding
        # delete: the database row is already gone, and an orphaned file is
        # harmless. Logged with the traceback for the operator.
        log.exception("failed to delete upload %s", filename)
        return False
    log.info("deleted upload %s", filename)
    return True
