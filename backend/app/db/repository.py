"""The Scan_Record domain type and its SQLite repository.

:class:`ScanRecord` is this layer's record: one instance per row of ``scans``,
covering every column. It is deliberately *not* a Pydantic model. The wire shapes
live in ``app.schemas`` (``HistoryItemOut``, ``CandidateOut``) and the routers do
the mapping, so the persistence layer can change a column without changing the
public API and vice versa.

Two conversions happen at the boundary and nowhere else:

* **Booleans.** SQLite has no boolean type, so ``is_uncertain`` and ``is_healthy``
  are stored as ``0`` / ``1`` (the schema's CHECK constraints enforce exactly
  that) and come back as real ``bool`` values. Nothing above this module should
  ever see an int for those two fields.
* **Candidates.** The top-3 candidate list is stored as one JSON text column,
  ``[{label, display_name, confidence} x3]``. It is read as a whole and never
  queried into, which is the reason it is a JSON blob instead of a child table --
  a second table would buy query-ability the application has no use for, at the
  cost of a join on every history row.

``created_at`` is written as ISO-8601 UTC with millisecond precision and a literal
``Z`` suffix (``2026-08-30T15:04:05.123Z``). Because that format sorts
lexicographically in chronological order, listing is a plain
``ORDER BY created_at DESC, id DESC`` served by ``idx_scans_created_at``
(Requirement 9.2), with ``id`` breaking ties between two scans written inside the
same millisecond.

:meth:`ScanRepository.delete` is row-first on purpose: read, delete the row,
commit, *then* unlink the image. A crash between the two steps leaves an orphaned
file, which is harmless and gets reported by :func:`sweep_orphaned_images` on the
next boot. The opposite order would leave a history row pointing at a file that no
longer exists, which the UI can only render as a broken image.
"""

from __future__ import annotations

import json
import re
import sqlite3
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field, replace
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from ..config import Settings, get_settings
from ..logging_config import get_logger
from .database import SCAN_COLUMNS, SCANS_TABLE

__all__ = [
    "CANDIDATE_COUNT",
    "DEFAULT_LIMIT",
    "UPLOAD_NAME_RE",
    "utc_now_iso",
    "to_iso_z",
    "ScanCandidate",
    "ScanRecord",
    "ScanRepository",
    "sweep_orphaned_images",
]

log = get_logger(__name__)

CANDIDATE_COUNT = 3
"""How many candidates a prediction stores. Enforced by the caller, not the schema."""

DEFAULT_LIMIT = 50
"""Default history page size (the router owns the 1..200 validation)."""

UPLOAD_NAME_RE = re.compile(r"^[0-9a-f]{32}\.(jpg|png|webp)$")
"""Server-generated upload filename shape: uuid4 hex plus a sniffed extension.

Duplicated from the storage service so this module can fall back to its own
containment check when ``app.services.storage`` is not importable. When storage
*is* available its gates are used instead -- see :func:`_unlink_image`.
"""

_INSERT_SQL = (
    f"INSERT INTO {SCANS_TABLE} ({', '.join(SCAN_COLUMNS)}) "
    f"VALUES ({', '.join(':' + column for column in SCAN_COLUMNS)})"
)
_SELECT_SQL = f"SELECT {', '.join(SCAN_COLUMNS)} FROM {SCANS_TABLE}"
_ORDER_BY = "ORDER BY created_at DESC, id DESC"


# --- time ------------------------------------------------------------------


def to_iso_z(moment: datetime) -> str:
    """Format ``moment`` as ISO-8601 UTC with milliseconds and a ``Z`` suffix.

    A naive datetime is assumed to be UTC; an aware one is converted. The output
    always has exactly three fractional digits, which keeps every stored value
    the same length and therefore lexicographically comparable.

    >>> to_iso_z(datetime(2026, 8, 30, 15, 4, 5, 123000, tzinfo=timezone.utc))
    '2026-08-30T15:04:05.123Z'
    """
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    return (
        moment.astimezone(timezone.utc)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )


def utc_now_iso() -> str:
    """Current UTC instant in the stored ``created_at`` format."""
    return to_iso_z(datetime.now(timezone.utc))


# --- domain types ----------------------------------------------------------


@dataclass(frozen=True, slots=True)
class ScanCandidate:
    """One entry of the stored top-3 candidate list."""

    label: str
    display_name: str
    confidence: float

    def to_dict(self) -> dict[str, Any]:
        """The exact JSON object shape held in ``candidates_json``."""
        return {
            "label": self.label,
            "display_name": self.display_name,
            "confidence": float(self.confidence),
        }

    @classmethod
    def from_mapping(cls, data: Mapping[str, Any]) -> ScanCandidate:
        """Rebuild from a decoded JSON object, tolerating missing keys.

        The data is written by this application, so a missing key means a bug or a
        hand-edited row; degrading to empty strings and ``0.0`` keeps one bad row
        from breaking the whole history page.
        """
        return cls(
            label=str(data.get("label", "")),
            display_name=str(data.get("display_name", "")),
            confidence=float(data.get("confidence", 0.0) or 0.0),
        )


def _coerce_candidates(
    candidates: Iterable[ScanCandidate | Mapping[str, Any]] | None,
) -> tuple[ScanCandidate, ...]:
    """Accept dataclasses or plain mappings; always return dataclasses."""
    if not candidates:
        return ()
    return tuple(
        item if isinstance(item, ScanCandidate) else ScanCandidate.from_mapping(item)
        for item in candidates
    )


@dataclass(frozen=True, slots=True)
class ScanRecord:
    """One row of ``scans``, one saved prediction.

    Field order matches the schema. ``recommendation_key`` is ``None`` exactly
    when the label resolved to the placeholder record, in which case
    ``resolution_stage`` is ``"placeholder"``.
    """

    id: str
    image_filename: str
    label: str
    resolution_stage: str
    display_name: str
    crop: str
    disease: str
    confidence: float
    model_used: str
    is_uncertain: bool
    is_healthy: bool
    created_at: str = field(default_factory=utc_now_iso)
    recommendation_key: str | None = None
    crop_hindi: str = ""
    candidates: tuple[ScanCandidate, ...] = ()

    def __post_init__(self) -> None:
        # Accept a list of dicts from callers that built candidates from JSON or
        # from CandidateOut models, without forcing them to import ScanCandidate.
        coerced = _coerce_candidates(self.candidates)
        if coerced != self.candidates:
            object.__setattr__(self, "candidates", coerced)

    # --- serialisation ---

    @property
    def candidates_json(self) -> str:
        """``candidates`` as the stored JSON text.

        ``ensure_ascii=False`` because ``display_name`` can carry non-ASCII text;
        the column is UTF-8 and storing escapes would only inflate it.
        """
        return json.dumps(
            [candidate.to_dict() for candidate in self.candidates],
            ensure_ascii=False,
        )

    def to_params(self) -> dict[str, Any]:
        """Named bind parameters for the INSERT, with bools narrowed to 0/1."""
        return {
            "id": self.id,
            "image_filename": self.image_filename,
            "label": self.label,
            "recommendation_key": self.recommendation_key,
            "resolution_stage": self.resolution_stage,
            "display_name": self.display_name,
            "crop": self.crop,
            "crop_hindi": self.crop_hindi or "",
            "disease": self.disease,
            "confidence": float(self.confidence),
            "model_used": self.model_used,
            "is_uncertain": int(bool(self.is_uncertain)),
            "is_healthy": int(bool(self.is_healthy)),
            "candidates_json": self.candidates_json,
            "created_at": self.created_at,
        }

    @classmethod
    def from_row(cls, row: sqlite3.Row | Mapping[str, Any]) -> ScanRecord:
        """Rebuild a record from a ``sqlite3.Row``, widening 0/1 back to ``bool``."""
        return cls(
            id=row["id"],
            image_filename=row["image_filename"],
            label=row["label"],
            recommendation_key=row["recommendation_key"],
            resolution_stage=row["resolution_stage"],
            display_name=row["display_name"],
            crop=row["crop"],
            crop_hindi=row["crop_hindi"] or "",
            disease=row["disease"],
            confidence=float(row["confidence"]),
            model_used=row["model_used"],
            is_uncertain=bool(row["is_uncertain"]),
            is_healthy=bool(row["is_healthy"]),
            candidates=_decode_candidates(row["candidates_json"], row["id"]),
            created_at=row["created_at"],
        )

    def replace(self, **changes: Any) -> ScanRecord:
        """Return a copy with ``changes`` applied (the record is frozen)."""
        return replace(self, **changes)


def _decode_candidates(raw: str | None, scan_id: str) -> tuple[ScanCandidate, ...]:
    """Decode ``candidates_json``; a malformed value degrades to ``()``.

    A history page must still render if one row's JSON is unreadable, so the
    failure is logged against the scan id rather than raised.
    """
    if not raw:
        return ()
    try:
        decoded = json.loads(raw)
    except (ValueError, TypeError):
        log.warning("scan %s has unreadable candidates_json; treating as empty", scan_id)
        return ()
    if not isinstance(decoded, Sequence) or isinstance(decoded, (str, bytes)):
        log.warning("scan %s has non-list candidates_json; treating as empty", scan_id)
        return ()
    return tuple(
        ScanCandidate.from_mapping(item)
        for item in decoded
        if isinstance(item, Mapping)
    )


# --- image deletion --------------------------------------------------------


def _storage_module() -> Any | None:
    """Import ``app.services.storage`` if it exists, else ``None``.

    Imported lazily rather than at module import time so this module stays usable
    while the storage service is still being written, and so a missing Pillow
    dependency in a DB-only test run cannot break history listing.
    """
    try:
        from ..services import storage  # noqa: PLC0415 - intentional lazy import
    except ImportError:
        return None
    return storage


def _fallback_upload_path(filename: str, uploads_dir: Path) -> Path | None:
    """Containment check used only when ``app.services.storage`` is unavailable.

    Mirrors ``storage.safe_upload_path``: basename equality (rejects ``..``,
    ``/``, ``\\``, drive-relative and UNC paths), the strict upload-name regex,
    and a post-``resolve()`` check that the result is really inside the uploads
    root (which is what catches a symlink pointing out of the tree). Returns
    ``None`` instead of raising, because a suspect filename must not turn an
    otherwise successful row delete into a 500.
    """
    if not filename or filename != Path(filename).name:
        return None
    if not UPLOAD_NAME_RE.fullmatch(filename):
        return None
    try:
        root = uploads_dir.resolve()
        candidate = (root / filename).resolve()
    except OSError:
        return None
    if candidate.parent != root:
        return None
    return candidate


def _unlink_image(filename: str, settings: Settings) -> bool:
    """Delete one stored upload, routed through the storage service when present.

    Preference order:

    1. ``storage.delete_image`` -- the service owns the whole operation.
    2. ``storage.safe_upload_path`` -- reuse its containment gates, unlink here.
    3. :func:`_fallback_upload_path` -- this module's own equivalent gates.

    Never raises. The row is already gone and committed by the time this runs, so
    a filesystem failure is logged and reported as ``False``; the file becomes an
    orphan that the startup sweep will name.
    """
    storage = _storage_module()

    try:
        if storage is not None and hasattr(storage, "delete_image"):
            result = storage.delete_image(filename, settings)
            return True if result is None else bool(result)

        if storage is not None and hasattr(storage, "safe_upload_path"):
            path = storage.safe_upload_path(filename, settings)
        else:
            path = _fallback_upload_path(filename, settings.uploads_dir)
            if path is None:
                log.warning("refusing to unlink suspicious image reference %r", filename)
                return False

        existed = path.exists()
        path.unlink(missing_ok=True)
        return existed
    except Exception:  # noqa: BLE001 - the row is committed; never re-raise here
        log.warning("could not delete image file %r", filename, exc_info=True)
        return False


# --- repository ------------------------------------------------------------


class ScanRepository:
    """Row-level access to ``scans`` over one caller-owned connection.

    The connection is injected, not created: request handlers get theirs from the
    ``get_connection`` dependency and the repository neither opens nor closes it.
    Writes are committed per call, since each public method is one complete unit
    of work from the API's point of view.
    """

    def __init__(
        self,
        conn: sqlite3.Connection,
        *,
        settings: Settings | None = None,
    ) -> None:
        self.conn = conn
        self.settings = settings or get_settings()

    # --- writes ---

    def insert(self, record: ScanRecord) -> ScanRecord:
        """Insert one scan and return it.

        Raises:
            sqlite3.IntegrityError: on a duplicate id or a CHECK violation
                (confidence outside ``[0, 1]``, an unknown ``model_used``, a
                boolean column that is not 0/1). These are programming errors,
                so they propagate to the 500 handler rather than being swallowed.
        """
        self.conn.execute(_INSERT_SQL, record.to_params())
        self.conn.commit()
        return record

    def delete(self, scan_id: str) -> bool:
        """Delete one scan and its image. ``False`` when the id is unknown.

        Row-first ordering, exactly as the design specifies:

        1. read the row (to learn the filename, and to distinguish 404 from 200),
        2. delete the row,
        3. commit,
        4. unlink the file.

        A crash between 3 and 4 leaves an orphaned file -- invisible to the UI and
        reported by :func:`sweep_orphaned_images` at next startup. File-first
        ordering would instead leave a history row whose image is gone.

        An unknown id short-circuits at step 1: no DELETE is issued, nothing is
        committed, and the uploads directory is not touched. The router turns the
        ``False`` into a 404.
        """
        record = self.get(scan_id)
        if record is None:
            return False

        self.conn.execute(f"DELETE FROM {SCANS_TABLE} WHERE id = ?", (scan_id,))
        self.conn.commit()

        _unlink_image(record.image_filename, self.settings)
        return True

    def delete_all(self) -> int:
        """Delete all scans and their images. Returns the number of deleted scans.

        Row-first ordering: reads all referenced filenames, deletes and commits
        all rows, then unlinks all files.
        """
        rows = self.conn.execute(f"SELECT image_filename FROM {SCANS_TABLE}").fetchall()
        filenames = [row[0] for row in rows if row[0]]

        self.conn.execute(f"DELETE FROM {SCANS_TABLE}")
        self.conn.commit()

        for filename in filenames:
            _unlink_image(filename, self.settings)

        return len(filenames)

    # --- reads ---

    def get(self, scan_id: str) -> ScanRecord | None:
        """One scan by id, or ``None`` when it does not exist."""
        row = self.conn.execute(
            f"{_SELECT_SQL} WHERE id = ?", (scan_id,)
        ).fetchone()
        return ScanRecord.from_row(row) if row is not None else None

    def list(self, limit: int = DEFAULT_LIMIT, offset: int = 0) -> list[ScanRecord]:
        """A page of scans, newest first (Req 9.2).

        Ordered ``created_at DESC, id DESC`` so two records written in the same
        millisecond still come back in a stable order. Range validation of
        ``limit`` (1..200) belongs to the router; negatives are clamped here so a
        direct caller cannot accidentally turn ``LIMIT -1`` into "every row".
        """
        safe_limit = max(0, int(limit))
        safe_offset = max(0, int(offset))
        rows = self.conn.execute(
            f"{_SELECT_SQL} {_ORDER_BY} LIMIT ? OFFSET ?",
            (safe_limit, safe_offset),
        ).fetchall()
        return [ScanRecord.from_row(row) for row in rows]

    def count(self) -> int:
        """Total number of stored scans, for the history ``total`` field."""
        row = self.conn.execute(f"SELECT COUNT(*) FROM {SCANS_TABLE}").fetchone()
        return int(row[0]) if row is not None else 0

    def image_filenames(self) -> set[str]:
        """Every referenced image filename. Used by the orphan sweep."""
        rows = self.conn.execute(
            f"SELECT image_filename FROM {SCANS_TABLE}"
        ).fetchall()
        return {row[0] for row in rows if row[0]}

    def sweep_orphaned_images(self) -> list[str]:
        """Convenience wrapper around :func:`sweep_orphaned_images`."""
        return sweep_orphaned_images(self.conn, settings=self.settings)


# --- startup sweep ---------------------------------------------------------


def sweep_orphaned_images(
    conn: sqlite3.Connection,
    *,
    settings: Settings | None = None,
) -> list[str]:
    """Log upload files with no owning row and return their names, sorted.

    Called once from the app lifespan. Reporting only -- nothing is deleted, since
    an unexpected file in ``uploads/`` is more likely to be someone's manual copy
    than something the application should destroy unattended.

    Only names matching :data:`UPLOAD_NAME_RE` are considered, so ``.gitkeep``,
    editor swap files and anything else a human put there are ignored rather than
    reported as orphans.
    """
    cfg = settings or get_settings()
    uploads_dir = cfg.uploads_dir

    if not uploads_dir.is_dir():
        log.debug("orphan sweep skipped: %s does not exist", uploads_dir)
        return []

    referenced = ScanRepository(conn, settings=cfg).image_filenames()

    orphans: list[str] = []
    try:
        entries = list(uploads_dir.iterdir())
    except OSError:
        log.warning("orphan sweep could not read %s", uploads_dir, exc_info=True)
        return []

    for entry in entries:
        if not entry.is_file():
            continue
        name = entry.name
        if not UPLOAD_NAME_RE.fullmatch(name):
            continue
        if name not in referenced:
            orphans.append(name)

    orphans.sort()
    if orphans:
        log.warning(
            "orphan sweep: %d upload file(s) in %s have no history row",
            len(orphans),
            uploads_dir,
        )
        for name in orphans:
            log.warning("orphaned upload file: %s", name)
    else:
        log.info("orphan sweep: no orphaned upload files in %s", uploads_dir)

    return orphans
