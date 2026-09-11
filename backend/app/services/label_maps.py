"""The two 91-label vocabularies the checkpoints were trained against.

The ViT checkpoint and the EfficientNet checkpoint use different label spaces, so
this module loads both and hands the label resolver everything it needs to map a
class index onto a name and, where the data supplies it, a ``(crop, disease)``
pair:

* ``data/class_names.json`` (EfficientNet) is a flat 91-element array. The index
  in that array *is* the class id, so order is load-bearing and never sorted.
  ``crop``/``disease`` is derived by splitting on the ``___`` separator; 53 of the
  91 entries are bare names (``Anthracnose``, ``Hispa``, ``Black Rot``) with no
  separator at all, and those report ``crop=None`` so the resolver skips its
  ``(crop, disease)`` stage and takes the pair from the recommendation record
  instead.
* ``data/names (3).json`` (ViT) is a dict keyed ``"0"``..``"90"``. Keys are
  ordered by integer value, not by string sort, so index 10 lands after index 9
  rather than after index 1. Each entry already carries ``crop``, ``disease`` and
  ``display_name``.

Two rules this module does not bend:

* Every file is read with ``encoding="utf-8"``. The data directory carries
  Devanagari text, and on Windows the default locale encoding is cp1252, where an
  unqualified read raises ``UnicodeDecodeError``.
* Filenames come from :class:`app.config.Settings` only -- specifically
  ``effnet_labels_path`` and ``vit_labels_path``, and nothing else. That is how
  Requirement 7.2 is kept: the superseded label file and the backup
  recommendation file in ``data/`` are named nowhere in this module, so no code
  path can reach them.

A structural problem (missing file, wrong length, a gap in the ``"0".."90"`` key
range) raises :class:`LabelMapError` at startup rather than degrading quietly,
because a label space that is off by one silently mislabels every prediction.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from ..config import Settings, get_settings
from ..logging_config import get_logger

__all__ = [
    "EFFNET_SEPARATOR",
    "EXPECTED_CLASS_COUNT",
    "LabelMapError",
    "VitLabelMeta",
    "EffnetLabelParts",
    "LabelMaps",
    "split_effnet_label",
    "derive_effnet_parts",
    "load_effnet_labels",
    "load_vit_labels",
    "load_label_maps",
]

log = get_logger(__name__)

EXPECTED_CLASS_COUNT = 91
"""Both checkpoints have a 91-way classifier head; both vocabularies must match it."""

EFFNET_SEPARATOR = "___"
"""``Apple___Apple_scab`` -> ``("Apple", "Apple_scab")``."""


class LabelMapError(ValueError):
    """A label vocabulary file is missing, malformed, or the wrong length."""


@dataclass(frozen=True, slots=True)
class VitLabelMeta:
    """The ``crop`` / ``disease`` / ``display_name`` trio carried by the ViT map."""

    crop: str
    disease: str
    display_name: str


@dataclass(frozen=True, slots=True)
class EffnetLabelParts:
    """A ``(crop, disease)`` pair derived from a bare EfficientNet label.

    ``crop`` is ``None`` for the 54 labels with no ``___`` separator. That is a
    deliberate signal, not a placeholder: the resolver's pair stage is guarded on
    a truthy crop, so a ``None`` here means "take the pair from the matched
    recommendation record" (design: fall back to the resolved record).
    """

    label: str
    crop: str | None
    disease: str


def split_effnet_label(label: str) -> tuple[str | None, str]:
    """Split an EfficientNet label on ``___``.

    Args:
        label: a label from ``class_names.json``, e.g. ``Apple___Apple_scab`` or
            the bare ``Hispa``.

    Returns:
        ``(crop, disease)``. ``crop`` is ``None`` when the label carries no
        separator, in which case ``disease`` is the whole label.

    Examples:
        >>> split_effnet_label("Apple___Apple_scab")
        ('Apple', 'Apple_scab')
        >>> split_effnet_label("Hispa")
        (None, 'Hispa')
        >>> split_effnet_label("Corn_(maize)___Cercospora_leaf_spot Gray_leaf_spot")
        ('Corn_(maize)', 'Cercospora_leaf_spot Gray_leaf_spot')
    """
    text = label.strip()
    crop, separator, disease = text.partition(EFFNET_SEPARATOR)
    if not separator:
        return None, text
    crop = crop.strip()
    disease = disease.strip()
    # A separator with nothing usable on one side is treated as a bare name
    # rather than as an empty crop, so downstream stages behave consistently.
    if not crop or not disease:
        return None, text
    return crop, disease


def derive_effnet_parts(label: str) -> EffnetLabelParts:
    """Return the derived ``(crop, disease)`` pair for one EfficientNet label."""
    crop, disease = split_effnet_label(label)
    return EffnetLabelParts(label=label, crop=crop, disease=disease)


def _read_json(path: Path, *, what: str) -> Any:
    """Read and parse a JSON file as UTF-8, with startup-legible failures."""
    try:
        text = Path(path).read_text(encoding="utf-8")
    except FileNotFoundError as exc:
        raise LabelMapError(f"{what} file not found: {path}") from exc
    except OSError as exc:
        raise LabelMapError(f"{what} file could not be read: {path}") from exc
    except UnicodeDecodeError as exc:  # pragma: no cover - guarded by encoding=
        raise LabelMapError(f"{what} file is not valid UTF-8: {path}") from exc

    try:
        return json.loads(text)
    except json.JSONDecodeError as exc:
        raise LabelMapError(f"{what} file is not valid JSON: {path} ({exc.msg})") from exc


def load_effnet_labels(path: Path) -> list[str]:
    """Load the EfficientNet vocabulary from ``class_names.json``.

    Args:
        path: ``Settings.effnet_labels_path``.

    Returns:
        91 label strings where the list index equals the class id.

    Raises:
        LabelMapError: the file is missing, is not a JSON array of strings, does
            not hold exactly 91 entries, or repeats a label.
    """
    raw = _read_json(path, what="EfficientNet label map")
    if not isinstance(raw, list):
        raise LabelMapError(
            f"EfficientNet label map must be a JSON array, got {type(raw).__name__}: {path}"
        )
    if len(raw) != EXPECTED_CLASS_COUNT:
        raise LabelMapError(
            f"EfficientNet label map must hold {EXPECTED_CLASS_COUNT} labels, "
            f"found {len(raw)}: {path}"
        )

    labels: list[str] = []
    for index, entry in enumerate(raw):
        if not isinstance(entry, str) or not entry.strip():
            raise LabelMapError(
                f"EfficientNet label at index {index} is not a non-empty string: {entry!r}"
            )
        labels.append(entry)

    duplicates = _duplicates(labels)
    if duplicates:
        raise LabelMapError(
            f"EfficientNet label map repeats {sorted(duplicates)}: {path}"
        )

    log.debug("loaded %d EfficientNet labels from %s", len(labels), path)
    return labels


def load_vit_labels(path: Path) -> tuple[list[str], dict[str, VitLabelMeta]]:
    """Load the ViT vocabulary from ``names (3).json``.

    Keys are read as ``str(i)`` for ``i`` in ``range(91)``, so the returned list
    is ordered by ``class_id`` regardless of the order the keys happen to appear
    in the file.

    Args:
        path: ``Settings.vit_labels_path``.

    Returns:
        ``(labels, meta)`` — the 91 ``class_name`` values in class-id order, and a
        ``class_name -> VitLabelMeta`` map.

    Raises:
        LabelMapError: the file is missing, is not a JSON object, is not exactly
            the key range ``"0".."90"``, has an entry whose ``class_id`` disagrees
            with its key, or repeats a ``class_name``.
    """
    raw = _read_json(path, what="ViT label map")
    if not isinstance(raw, dict):
        raise LabelMapError(
            f"ViT label map must be a JSON object, got {type(raw).__name__}: {path}"
        )
    if len(raw) != EXPECTED_CLASS_COUNT:
        raise LabelMapError(
            f"ViT label map must hold {EXPECTED_CLASS_COUNT} entries, "
            f"found {len(raw)}: {path}"
        )

    missing = [str(i) for i in range(EXPECTED_CLASS_COUNT) if str(i) not in raw]
    if missing:
        raise LabelMapError(
            f"ViT label map is missing key(s) {missing[:10]} in the range "
            f'"0".."{EXPECTED_CLASS_COUNT - 1}": {path}'
        )

    labels: list[str] = []
    meta: dict[str, VitLabelMeta] = {}
    for index in range(EXPECTED_CLASS_COUNT):
        key = str(index)
        entry = raw[key]
        if not isinstance(entry, dict):
            raise LabelMapError(
                f"ViT label map entry {key!r} must be an object, got {type(entry).__name__}"
            )

        class_name = entry.get("class_name")
        if not isinstance(class_name, str) or not class_name.strip():
            raise LabelMapError(
                f"ViT label map entry {key!r} has no usable 'class_name': {class_name!r}"
            )

        class_id = entry.get("class_id", index)
        if class_id != index:
            raise LabelMapError(
                f"ViT label map entry {key!r} declares class_id {class_id!r}; "
                "keys must match class_id so list order is the model's output order"
            )

        labels.append(class_name)
        meta[class_name] = VitLabelMeta(
            crop=str(entry.get("crop") or ""),
            disease=str(entry.get("disease") or ""),
            display_name=str(entry.get("display_name") or ""),
        )

    duplicates = _duplicates(labels)
    if duplicates:
        # The meta map is keyed by class_name, so a repeat would silently drop an
        # entry and leave len(meta) < 91.
        raise LabelMapError(f"ViT label map repeats class_name {sorted(duplicates)}: {path}")

    if len(meta) != EXPECTED_CLASS_COUNT:  # pragma: no cover - implied by the check above
        raise LabelMapError(
            f"ViT label meta must hold {EXPECTED_CLASS_COUNT} entries, found {len(meta)}"
        )

    log.debug("loaded %d ViT labels from %s", len(labels), path)
    return labels, meta


@dataclass(frozen=True, slots=True)
class LabelMaps:
    """Both vocabularies, loaded once at startup and shared read-only."""

    effnet_labels: list[str]
    vit_labels: list[str]
    vit_meta: dict[str, VitLabelMeta]
    effnet_parts: dict[str, EffnetLabelParts]

    def labels_for(self, model_id: str) -> list[str]:
        """Return the vocabulary for ``model_id`` (``"vit_b16"`` / ``"effnet_b3"``)."""
        key = model_id.lower()
        if "vit" in key:
            return self.vit_labels
        if "eff" in key:
            return self.effnet_labels
        raise KeyError(f"unknown model id for label lookup: {model_id!r}")

    def all_labels(self) -> list[str]:
        """Every label from both maps, EfficientNet first, order preserved."""
        return [*self.effnet_labels, *self.vit_labels]


def load_label_maps(settings: Settings | None = None) -> LabelMaps:
    """Load both vocabularies using paths from settings (Req 7.2, 7.3, 7.4).

    Args:
        settings: defaults to :func:`app.config.get_settings`. Only
            ``effnet_labels_path`` and ``vit_labels_path`` are read, so the
            excluded data files are unreachable from here.
    """
    cfg = settings or get_settings()

    effnet_labels = load_effnet_labels(cfg.effnet_labels_path)
    vit_labels, vit_meta = load_vit_labels(cfg.vit_labels_path)
    effnet_parts = {label: derive_effnet_parts(label) for label in effnet_labels}

    bare = sum(1 for parts in effnet_parts.values() if parts.crop is None)
    log.info(
        "label maps loaded: effnet=%d vit=%d (effnet labels without a %r separator: %d)",
        len(effnet_labels),
        len(vit_labels),
        EFFNET_SEPARATOR,
        bare,
    )

    return LabelMaps(
        effnet_labels=effnet_labels,
        vit_labels=vit_labels,
        vit_meta=vit_meta,
        effnet_parts=effnet_parts,
    )


def _duplicates(values: list[str]) -> set[str]:
    seen: set[str] = set()
    repeated: set[str] = set()
    for value in values:
        if value in seen:
            repeated.add(value)
        else:
            seen.add(value)
    return repeated
