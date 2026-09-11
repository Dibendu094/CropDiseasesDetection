"""Logging configuration and startup-logging helpers.

This module is deliberately dependency-free: it imports nothing from the rest of
``app``. The startup helpers take plain mappings and sequences rather than the
dataclasses owned by the registry or the resolver, so ``model_registry``,
``label_resolver`` and ``main`` can all call in without a circular import.

Three behaviours matter beyond "set up a logger":

* ``configure_logging`` is idempotent. Calling it twice (tests, a reload, an
  embedded uvicorn worker) re-uses the one handler it installed instead of
  stacking a second copy and double-printing every line.
* The handler stream is forced to UTF-8 with ``errors="backslashreplace"``. The
  recommendation data carries Devanagari ``crop_hindi`` values, and a Windows
  console defaults to cp1252; an unencodable character must degrade to an escape
  sequence in the log line, never raise inside ``logging`` (Req 10.3, 10.6).
* Because the handler cannot raise on encoding, ``log.exception`` /
  ``exc_info=True`` traceback logging from the catch-all exception handler
  (Req 10.6) is safe even when the traceback text contains non-ASCII.
"""

from __future__ import annotations

import io
import logging
import sys
from collections.abc import Iterable, Mapping, Sequence
from typing import Any

__all__ = [
    "APP_LOGGER_NAME",
    "LOG_FORMAT",
    "DATE_FORMAT",
    "configure_logging",
    "get_logger",
    "log_resolved_paths",
    "format_stage_histogram",
    "log_stage_histogram",
    "log_unresolved_labels",
    "format_readiness_summary",
    "log_readiness_summary",
]

APP_LOGGER_NAME = "cropdisease"
"""Root of the application logger tree. Every module uses ``get_logger(__name__)``."""

LOG_FORMAT = "%(asctime)s %(levelname)-8s %(name)s: %(message)s"
DATE_FORMAT = "%Y-%m-%d %H:%M:%S"

_DEFAULT_LEVEL = "INFO"

# Marks the handler this module owns so repeated configure_logging() calls can
# find and re-use it instead of appending another one.
_OWNED_HANDLER_ATTR = "_crop_disease_owned"

# Kept alive at module scope: if a TextIOWrapper we built over sys.stdout.buffer
# were garbage collected it would close the underlying buffer.
_wrapped_stream: io.TextIOWrapper | None = None

# Canonical resolver stage order (design: exact -> normalized -> pair -> alias).
_STAGE_ORDER = ("exact", "normalized", "pair", "alias", "placeholder")


def _resolve_level(level: int | str | None) -> int:
    """Turn ``"debug"``, ``"INFO"``, ``10`` or ``None`` into a logging level int."""
    if level is None:
        return logging.INFO
    if isinstance(level, int):
        return level
    named = logging.getLevelName(str(level).strip().upper())
    return named if isinstance(named, int) else logging.INFO


def _utf8_stream(stream: Any) -> Any:
    """Return ``stream`` made safe for non-ASCII output.

    Prefers reconfiguring in place (no new object owns the file descriptor). Falls
    back to a wrapper over the binary buffer, and finally to the stream as-is so
    that a detached or exotic stdout can never break startup.
    """
    global _wrapped_stream

    reconfigure = getattr(stream, "reconfigure", None)
    if callable(reconfigure):
        try:
            reconfigure(encoding="utf-8", errors="backslashreplace")
            return stream
        except (ValueError, OSError, LookupError):
            pass

    buffer = getattr(stream, "buffer", None)
    if buffer is not None:
        try:
            _wrapped_stream = io.TextIOWrapper(
                buffer,
                encoding="utf-8",
                errors="backslashreplace",
                line_buffering=True,
            )
            return _wrapped_stream
        except (ValueError, OSError, LookupError):
            pass

    return stream


def _find_owned_handler(logger: logging.Logger) -> logging.Handler | None:
    for handler in logger.handlers:
        if getattr(handler, _OWNED_HANDLER_ATTR, False):
            return handler
    return None


def configure_logging(level: int | str | None = _DEFAULT_LEVEL) -> logging.Logger:
    """Install one UTF-8 stream handler on the root logger and return the app logger.

    Idempotent: a second call updates the level and formatter on the handler it
    already owns rather than adding another, so repeated calls in tests or on a
    dev-server reload never duplicate log lines.

    Args:
        level: ``"DEBUG"`` / ``"INFO"`` / ... or a ``logging`` level int. An
            unrecognised value falls back to ``INFO`` instead of raising, because
            a typo in ``LOG_LEVEL`` must not stop the server from booting.

    Returns:
        The named application logger (``cropdisease``).
    """
    resolved = _resolve_level(level)
    root = logging.getLogger()

    handler = _find_owned_handler(root)
    if handler is None:
        handler = logging.StreamHandler(_utf8_stream(sys.stdout))
        setattr(handler, _OWNED_HANDLER_ATTR, True)
        root.addHandler(handler)

    handler.setFormatter(logging.Formatter(fmt=LOG_FORMAT, datefmt=DATE_FORMAT))
    handler.setLevel(resolved)
    root.setLevel(resolved)

    app_logger = logging.getLogger(APP_LOGGER_NAME)
    app_logger.setLevel(resolved)
    # Records propagate up to the single root handler; no handler is attached
    # here, so there is exactly one stream handler in the process.
    app_logger.propagate = True

    return app_logger


def get_logger(name: str | None = None) -> logging.Logger:
    """Return a child of the application logger.

    ``get_logger(__name__)`` from ``app.services.inference`` yields
    ``cropdisease.services.inference``; the leading ``app.`` is dropped so the
    tree has one readable root.
    """
    if not name or name == APP_LOGGER_NAME:
        return logging.getLogger(APP_LOGGER_NAME)
    suffix = name
    for prefix in ("app.", f"{APP_LOGGER_NAME}."):
        if suffix.startswith(prefix):
            suffix = suffix[len(prefix) :]
            break
    if suffix in ("app", ""):
        return logging.getLogger(APP_LOGGER_NAME)
    return logging.getLogger(f"{APP_LOGGER_NAME}.{suffix}")


def log_resolved_paths(
    paths: Mapping[str, Any],
    *,
    logger: logging.Logger | None = None,
    level: int = logging.INFO,
) -> None:
    """Log every resolved path with a present/missing marker.

    Startup step 1 calls this with the settings-derived paths. A missing model
    checkpoint is logged as ``MISSING`` here and again by the registry, which is
    what Req 10.3 asks for.

    Args:
        paths: ``{"models_dir": Path(...), "vit_checkpoint": Path(...)}``. Values
            may be ``Path`` or ``str``; ``None`` is reported as ``unset``.
        logger: defaults to the application logger.
        level: level for the present-path lines. Missing paths always log at
            ``WARNING`` so they are visible at any configured level.
    """
    log = logger or logging.getLogger(APP_LOGGER_NAME)
    if not paths:
        return

    width = max(len(str(name)) for name in paths)
    for name, value in paths.items():
        if value is None:
            log.log(level, "path %-*s = <unset>", width, name)
            continue
        state = "present"
        try:
            # Accepts Path directly; str is wrapped by os.path semantics below.
            exists = value.exists() if hasattr(value, "exists") else None
        except OSError:
            exists = None
        if exists is False:
            state = "MISSING"
        if state == "MISSING":
            log.warning("path %-*s = %s (MISSING)", width, name, value)
        elif exists is None:
            log.log(level, "path %-*s = %s", width, name, value)
        else:
            log.log(level, "path %-*s = %s (present)", width, name, value)


def _ordered_stages(counts: Mapping[str, Any]) -> list[tuple[str, Any]]:
    known = [(stage, counts[stage]) for stage in _STAGE_ORDER if stage in counts]
    extra = [(stage, value) for stage, value in counts.items() if stage not in _STAGE_ORDER]
    return known + extra


def format_stage_histogram(histogram: Mapping[str, Any]) -> str:
    """Render a resolver stage histogram as one compact string.

    Accepts either a flat histogram (``{"exact": 140, "alias": 11}``) or one
    nested per label map (``{"effnet": {"exact": 91}, "vit": {...}}``), which is
    the shape the startup coverage assertion produces.
    """
    if not histogram:
        return "{}"

    nested = any(isinstance(value, Mapping) for value in histogram.values())
    if not nested:
        inner = " ".join(f"{stage}={count}" for stage, count in _ordered_stages(histogram))
        return "{" + inner + "}"

    groups = []
    for group, counts in histogram.items():
        if isinstance(counts, Mapping):
            inner = " ".join(f"{stage}={count}" for stage, count in _ordered_stages(counts))
            groups.append(f"{group}[{inner}]")
        else:
            groups.append(f"{group}={counts}")
    return "{" + " ".join(groups) + "}"


def log_stage_histogram(
    histogram: Mapping[str, Any],
    *,
    logger: logging.Logger | None = None,
    level: int = logging.INFO,
) -> None:
    """Log the resolver stage histogram (Req 7.7)."""
    log = logger or logging.getLogger(APP_LOGGER_NAME)
    log.log(level, "label resolution stages %s", format_stage_histogram(histogram))


def log_unresolved_labels(
    unresolved: Iterable[Any],
    *,
    logger: logging.Logger | None = None,
    source: str | None = None,
) -> int:
    """Log every label that failed to resolve, by name (Req 7.7).

    Args:
        unresolved: label strings, or ``(label, source)`` pairs.
        source: optional label-map name used when items are bare strings.

    Returns:
        The number of unresolved labels logged.
    """
    log = logger or logging.getLogger(APP_LOGGER_NAME)
    items = list(unresolved)
    if not items:
        log.info("label coverage complete: 0 unresolved labels%s",
                 f" in {source}" if source else "")
        return 0

    log.error("label coverage incomplete: %d unresolved label(s)%s",
              len(items), f" in {source}" if source else "")
    for item in items:
        if isinstance(item, (tuple, list)) and len(item) == 2:
            log.error("unresolved label: %r (source: %s)", item[0], item[1])
        else:
            log.error("unresolved label: %r%s", item, f" (source: {source})" if source else "")
    return len(items)


def _format_model_state(model_id: str, state: Any) -> str:
    """``vit_b16=loaded`` / ``vit_b16=unavailable(checkpoint_missing)``."""
    if isinstance(state, Mapping):
        loaded = bool(state.get("loaded", False))
        error = state.get("error")
        role = state.get("role")
    else:
        loaded = bool(state)
        error = None
        role = None

    label = model_id if not role else f"{model_id}/{role}"
    if loaded:
        return f"{label}=loaded"
    return f"{label}=unavailable({error})" if error else f"{label}=unavailable"


def format_readiness_summary(
    models: Mapping[str, Any] | None = None,
    stage_histogram: Mapping[str, Any] | None = None,
    record_counts: Mapping[str, Any] | None = None,
    unresolved: Sequence[Any] | None = None,
    device: str | None = None,
) -> str:
    """Build the one-line readiness summary (startup step 7).

    All arguments are plain mappings so the caller does not have to import a
    dataclass from this module, and this module does not have to import one from
    the registry.

    Args:
        models: ``{"vit_b16": {"role": "primary", "loaded": True, "error": None}}``.
            A bare bool value is also accepted.
        stage_histogram: resolver stage counts, flat or nested per label map.
        record_counts: ``{"records": 140, "crops": 32, "labels": 182}``.
        unresolved: labels that failed to resolve; only the count is shown here,
            the names are logged separately by ``log_unresolved_labels``.
        device: ``"cpu"`` / ``"cuda"``.
    """
    parts = ["backend ready"]

    if models:
        rendered = " ".join(_format_model_state(mid, state) for mid, state in models.items())
        parts.append(f"models[{rendered}]")

    if record_counts:
        rendered = " ".join(f"{key}={value}" for key, value in record_counts.items())
        parts.append(f"counts[{rendered}]")

    if stage_histogram:
        parts.append(f"stages{format_stage_histogram(stage_histogram)}")

    if unresolved is not None:
        parts.append(f"unresolved={len(unresolved)}")

    if device:
        parts.append(f"device={device}")

    return " ".join(parts)


def log_readiness_summary(
    models: Mapping[str, Any] | None = None,
    stage_histogram: Mapping[str, Any] | None = None,
    record_counts: Mapping[str, Any] | None = None,
    unresolved: Sequence[Any] | None = None,
    device: str | None = None,
    *,
    logger: logging.Logger | None = None,
) -> str:
    """Log the readiness summary line and return it.

    Logged at ``WARNING`` when a model is unavailable or a label is unresolved,
    otherwise at ``INFO`` — a degraded boot should stand out even when the
    configured level hides informational lines.
    """
    log = logger or logging.getLogger(APP_LOGGER_NAME)
    line = format_readiness_summary(models, stage_histogram, record_counts, unresolved, device)

    degraded = bool(unresolved)
    for state in (models or {}).values():
        loaded = state.get("loaded", False) if isinstance(state, Mapping) else state
        if not loaded:
            degraded = True
            break

    log.log(logging.WARNING if degraded else logging.INFO, "%s", line)
    return line
