"""SQLite connection management and schema for the scan history store.

Design decision D3: the standard library ``sqlite3`` module and nothing else. No
SQLAlchemy, no Alembic. The schema is a single table plus one index; a migration
framework would be more machinery than the whole persistence layer.

Three things are worth knowing before editing:

* **The schema is idempotent, not versioned.** ``apply_schema`` is
  ``CREATE TABLE IF NOT EXISTS`` / ``CREATE INDEX IF NOT EXISTS``, so calling it
  on every boot is a no-op after the first. Adding a column later means writing
  an explicit ``ALTER TABLE`` guarded by a ``PRAGMA table_info`` check -- there is
  no framework to do it for you, and that is the deliberate trade.
* **One connection per request, never one shared connection.** Route handlers are
    sync ``def``, so FastAPI runs them in its worker threadpool and each call gets
    its own connection from :func:`get_connection`. FastAPI may run dependency
    cleanup on a different worker thread, so each private connection allows that
    handoff with ``check_same_thread=False``.
* **Pragmas are per-connection except one.** ``journal_mode=WAL`` is persisted in
  the database header, so it survives; ``foreign_keys=ON`` is per-connection and
  has to be re-issued on every ``connect``. Both are set every time regardless,
  which costs one statement and removes a class of "worked in dev" bug.

The stored ``created_at`` is an ISO-8601 UTC string ending in ``Z``. That format
sorts lexicographically in the same order as chronologically, which is what lets
``idx_scans_created_at`` (``created_at DESC, id DESC``) serve the newest-first
history listing of Requirement 9.2 directly, with a stable tie-break for two rows
written in the same millisecond.
"""

from __future__ import annotations

import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

from ..config import Settings, get_settings
from ..logging_config import get_logger

__all__ = [
    "SCANS_TABLE",
    "CREATED_AT_INDEX",
    "MODEL_IDS",
    "RESOLUTION_STAGES",
    "SCAN_COLUMNS",
    "SCHEMA_STATEMENTS",
    "SCHEMA_SQL",
    "connect",
    "connection",
    "apply_schema",
    "ensure_directories",
    "init_db",
    "get_connection",
    "table_exists",
    "index_exists",
    "journal_mode",
    "foreign_keys_enabled",
]

log = get_logger(__name__)

SCANS_TABLE = "scans"
CREATED_AT_INDEX = "idx_scans_created_at"

MODEL_IDS: tuple[str, ...] = ("vit_b16", "efficientnet_b3")
"""The only two values the ``model_used`` CHECK constraint admits."""

RESOLUTION_STAGES: tuple[str, ...] = (
    "exact",
    "normalized",
    "pair",
    "alias",
    "placeholder",
)
"""Label-resolver stages. Stored as free text; the resolver owns the vocabulary."""

SCAN_COLUMNS: tuple[str, ...] = (
    "id",
    "image_filename",
    "label",
    "recommendation_key",
    "resolution_stage",
    "display_name",
    "crop",
    "crop_hindi",
    "disease",
    "confidence",
    "model_used",
    "is_uncertain",
    "is_healthy",
    "candidates_json",
    "created_at",
)
"""Column order of ``scans``, used to build INSERT/SELECT statements."""


# Kept as separate statements rather than one script so a failure names the
# statement that failed, and so the index can be asserted independently in tests.
_CREATE_SCANS = """
CREATE TABLE IF NOT EXISTS scans (
    id                  TEXT    PRIMARY KEY,
    image_filename      TEXT    NOT NULL,
    label               TEXT    NOT NULL,
    recommendation_key  TEXT,
    resolution_stage    TEXT    NOT NULL,
    display_name        TEXT    NOT NULL,
    crop                TEXT    NOT NULL,
    crop_hindi          TEXT    NOT NULL DEFAULT '',
    disease             TEXT    NOT NULL,
    confidence          REAL    NOT NULL CHECK (confidence >= 0.0 AND confidence <= 1.0),
    model_used          TEXT    NOT NULL CHECK (model_used IN ('vit_b16', 'efficientnet_b3')),
    is_uncertain        INTEGER NOT NULL CHECK (is_uncertain IN (0, 1)),
    is_healthy          INTEGER NOT NULL CHECK (is_healthy IN (0, 1)),
    candidates_json     TEXT    NOT NULL,
    created_at          TEXT    NOT NULL
)
""".strip()

_CREATE_CREATED_AT_INDEX = (
    "CREATE INDEX IF NOT EXISTS idx_scans_created_at ON scans (created_at DESC, id DESC)"
)

SCHEMA_STATEMENTS: tuple[str, ...] = (_CREATE_SCANS, _CREATE_CREATED_AT_INDEX)
"""Every DDL statement, in dependency order (table before its index)."""

SCHEMA_SQL = ";\n\n".join(SCHEMA_STATEMENTS) + ";"
"""The full schema as one script, for logging and for ``executescript`` callers."""


def _resolve_db_path(
    db_path: str | Path | None = None,
    settings: Settings | None = None,
) -> str | Path:
    """Pick the database location: explicit argument, then settings, then default.

    ``":memory:"`` and other sqlite URIs are passed straight through -- they are
    not filesystem paths and must not be resolved.
    """
    if db_path is not None:
        return db_path
    return (settings or get_settings()).db_path


def _is_file_backed(db_path: str | Path) -> bool:
    """False for ``:memory:`` and for shared-cache in-memory URIs."""
    text = str(db_path)
    return text != ":memory:" and "mode=memory" not in text


def ensure_directories(settings: Settings | None = None) -> None:
    """Create the uploads directory and the database's parent on first boot.

    Both are ``mkdir(parents=True, exist_ok=True)``, so this is safe to call on
    every start. ``uploads/`` is created here rather than in the storage service
    because ``safe_upload_path`` resolves the uploads root with ``strict=True``
    and would raise if the directory did not exist yet.
    """
    cfg = settings or get_settings()

    cfg.uploads_dir.mkdir(parents=True, exist_ok=True)
    if _is_file_backed(cfg.db_path):
        Path(cfg.db_path).parent.mkdir(parents=True, exist_ok=True)


def connect(
    db_path: str | Path | None = None,
    *,
    settings: Settings | None = None,
) -> sqlite3.Connection:
    """Open one connection with the project's pragmas and row factory applied.

    Args:
        db_path: explicit database file, ``":memory:"``, or ``None`` to take
            ``Settings.db_path``.
        settings: settings instance used when ``db_path`` is omitted.

    Returns:
        A connection with ``row_factory = sqlite3.Row`` (so callers index rows by
        column name), ``journal_mode=WAL`` and ``foreign_keys=ON``.

    Notes:
        WAL is unavailable for in-memory databases; sqlite silently answers
        ``memory`` to the pragma there instead of failing, and that is fine -- an
        in-memory database has no concurrent readers to protect.
    """
    target = _resolve_db_path(db_path, settings)
    # FastAPI can resume a generator dependency's cleanup on a different worker
    # thread from the one that created the connection. Each connection remains
    # request-local, so allowing that close handoff is safe here.
    conn = sqlite3.connect(target, check_same_thread=False)
    conn.row_factory = sqlite3.Row

    # WAL: readers never block the writer, which matters because a history list
    # can be served while a prediction is being inserted.
    conn.execute("PRAGMA journal_mode=WAL")
    # Per-connection, and off by default in sqlite. Set even though the current
    # schema has no foreign keys, so adding one later is correct by default.
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


@contextmanager
def connection(
    db_path: str | Path | None = None,
    *,
    settings: Settings | None = None,
) -> Iterator[sqlite3.Connection]:
    """Context-managed :func:`connect`, closed in a ``finally``.

    For scripts, startup tasks and tests. Request handling uses
    :func:`get_connection` instead.
    """
    conn = connect(db_path, settings=settings)
    try:
        yield conn
    finally:
        conn.close()


def apply_schema(conn: sqlite3.Connection) -> None:
    """Create the ``scans`` table and its index if they are not already there.

    Idempotent by construction (``IF NOT EXISTS`` on both statements), so this
    runs unconditionally on every startup.
    """
    for statement in SCHEMA_STATEMENTS:
        conn.execute(statement)
    conn.commit()


def init_db(
    db_path: str | Path | None = None,
    *,
    settings: Settings | None = None,
) -> Path | str:
    """Prepare the filesystem and the schema. Call once from the app lifespan.

    Creates ``uploads/`` and the database's parent directory, opens a short-lived
    connection, applies the schema, and closes it. The per-request connections
    that follow therefore never race to create the table.

    Returns:
        The database location that was initialised, for the startup path log.
    """
    cfg = settings or get_settings()
    target = _resolve_db_path(db_path, cfg)

    if db_path is None:
        ensure_directories(cfg)
    elif _is_file_backed(target):
        Path(target).parent.mkdir(parents=True, exist_ok=True)

    with connection(target, settings=cfg) as conn:
        apply_schema(conn)
        mode = journal_mode(conn)

    log.info("database ready at %s (journal_mode=%s)", target, mode)
    return target


def get_connection(
    settings: Settings | None = None,
) -> Iterator[sqlite3.Connection]:
    """FastAPI dependency yielding one connection per request.

    Used as ``conn: sqlite3.Connection = Depends(get_connection)``. The
    connection is closed in a ``finally`` whether the handler returned or raised.
    Handlers are sync ``def``, so each runs in a threadpool worker and owns its
    connection outright -- nothing is shared across threads, which is why
    ``check_same_thread`` is left alone.
    """
    conn = connect(settings=settings)
    try:
        yield conn
    finally:
        conn.close()


# --- introspection helpers (startup logging and tests) ---------------------


def table_exists(conn: sqlite3.Connection, name: str = SCANS_TABLE) -> bool:
    """True when a table called ``name`` is present."""
    row = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
        (name,),
    ).fetchone()
    return row is not None


def index_exists(conn: sqlite3.Connection, name: str = CREATED_AT_INDEX) -> bool:
    """True when an index called ``name`` is present."""
    row = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?",
        (name,),
    ).fetchone()
    return row is not None


def journal_mode(conn: sqlite3.Connection) -> str:
    """The connection's journal mode, lower-cased (``wal`` for file databases)."""
    row = conn.execute("PRAGMA journal_mode").fetchone()
    return str(row[0]).lower() if row is not None else ""


def foreign_keys_enabled(conn: sqlite3.Connection) -> bool:
    """True when ``PRAGMA foreign_keys`` is on for this connection."""
    row = conn.execute("PRAGMA foreign_keys").fetchone()
    return bool(row[0]) if row is not None else False
