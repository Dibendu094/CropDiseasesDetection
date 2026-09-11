"""The Recommendation_Store: guidance records merged from the two permitted data files.

``data/disease_info.json`` holds 91 records keyed the EfficientNet way
(``Apple___Apple_scab``); ``data/disease_info_ext.json`` holds 49 keyed the ViT way
(``Cassava__healthy``). Merging them yields 140 records and, as measured against the
current files, zero key collisions -- so merge order loses nothing today. The base file
is still loaded first and wins any future collision, because it is the canonical set the
EfficientNet checkpoint was trained against.

Three rules this module does not bend:

* Both filenames come from :class:`app.config.Settings` and nothing else -- there is no
  directory scan and no filename literal in this module. That is how Requirement 7.2 is
  kept: the excluded backup and alternate-names files in ``data/`` are unreachable from
  here, because the only two paths this module can open are the two settings properties.
* Every read passes ``encoding="utf-8"``. ``crop_hindi`` carries Devanagari text and the
  Windows default locale encoding (cp1252) raises ``UnicodeDecodeError`` on it.
* The metadata figures (crops, canonical classes, healthy classes, records) are computed
  from the loaded records at build time, never hard-coded (Req 2.2).

Emptiness is normal, not an error. Measured over the 140 records: ``affected_parts`` is
non-empty in 115, ``chemical_spray`` in 108, ``treatment`` in 62. Records are therefore
loaded with tolerant coercion and every field defaults to an empty value, so a consumer
can decide on emptiness alone and never needs a null check.

Two presentation quirks live in :class:`RecommendationView` rather than in the data:

* ``prevention`` and ``preventive_measures`` are byte-identical in many records. The view
  collapses the duplicate into ``preventive_measures`` and reports ``prevention == []`` so
  the UI never prints one list twice under two headings.
* ``farmer_tips`` entries already begin with a ``\u2022`` bullet. That is left exactly as the
  data has it -- stripping happens in the frontend renderer -- and nothing here depends on
  the leading character.

Naming: :class:`Recommendation` is this module's internal record. The wire-level models
(``RecommendationOut``, ``FertilizerItemOut``, ``TreatmentItemOut``) live in
``app.schemas``; :meth:`RecommendationView.to_out` is the one bridge between the two.
"""

from __future__ import annotations

import json
from collections.abc import Iterator, Mapping
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, field_validator

from ..config import Settings, get_settings
from ..logging_config import get_logger
from ..schemas import FertilizerItemOut, RecommendationOut, TreatmentItemOut

__all__ = [
    "BASE_RECORD_COUNT",
    "EXT_RECORD_COUNT",
    "EXPECTED_RECORD_COUNT",
    "RECOMMENDATION_FIELDS",
    "STRING_FIELDS",
    "TEXT_LIST_FIELDS",
    "ITEM_LIST_FIELDS",
    "RecommendationDataError",
    "Recommendation",
    "RecommendationView",
    "StoreMetadata",
    "RecommendationStore",
    "load_disease_info",
    "build_recommendation_store",
    "get_recommendation_store",
    "reset_recommendation_store",
]

log = get_logger(__name__)

BASE_RECORD_COUNT = 91
"""Measured size of ``disease_info.json`` -- also the EfficientNet class count."""

EXT_RECORD_COUNT = 49
"""Measured size of ``disease_info_ext.json`` -- the ViT-keyed additions."""

EXPECTED_RECORD_COUNT = BASE_RECORD_COUNT + EXT_RECORD_COUNT
"""140. A deviation is logged as a warning, not raised: the data may legitimately grow."""

STRING_FIELDS: tuple[str, ...] = (
    "crop",
    "crop_hindi",
    "disease",
    "description",
    "cause",
    "best_time_to_spray",
)
"""Fields carrying a single string. Non-empty in all 140 records as measured."""

TEXT_LIST_FIELDS: tuple[str, ...] = (
    "affected_parts",
    "symptoms",
    "organic_remedy",
    "chemical_spray",
    "preventive_measures",
    "prevention",
    "safety_tips",
    "farmer_tips",
)
"""Fields carrying a list of strings. ``affected_parts`` and ``chemical_spray`` are
empty in some records (115/140 and 108/140), which is tolerated, not repaired."""

ITEM_LIST_FIELDS: tuple[str, ...] = ("fertilizers", "treatment")
"""Fields carrying a list of objects: ``fertilizers`` is ``{name, purpose}``,
``treatment`` is ``{name, purpose, application, dosage, interval, safety}``. Unknown
keys are preserved rather than dropped, so a hand-authored extra renders as one more
row instead of vanishing. ``treatment`` is empty in 78 of 140 records."""

RECOMMENDATION_FIELDS: tuple[str, ...] = (
    "crop",
    "crop_hindi",
    "disease",
    "is_healthy",
    "description",
    "cause",
    "affected_parts",
    "symptoms",
    "organic_remedy",
    "chemical_spray",
    "preventive_measures",
    "prevention",
    "best_time_to_spray",
    "fertilizers",
    "safety_tips",
    "farmer_tips",
    "treatment",
)
"""The 17 fields of Requirement 7's Recommendation, in the order the requirement lists
them. ``is_placeholder`` is deliberately not here: it is this application's flag, not a
field of the data."""


class RecommendationDataError(ValueError):
    """A recommendation data file is missing, unreadable, or structurally wrong.

    Raised for problems that make the store meaningless (no file, not JSON, not a JSON
    object of records). Field-level gaps are logged and defaulted instead, because a
    record with an empty ``chemical_spray`` is ordinary data, not a broken file.
    """


# --- coercion helpers -------------------------------------------------------------------


def _as_str(value: Any) -> str:
    """Coerce a scalar to a stripped string; ``None`` becomes ``""``."""
    if value is None:
        return ""
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value)


def _as_bool(value: Any) -> bool:
    """Coerce ``is_healthy`` to bool, accepting the string spellings JSON might carry."""
    if isinstance(value, bool):
        return value
    if value is None:
        return False
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes", "y"}
    return bool(value)


def _as_text_list(value: Any) -> list[str]:
    """Coerce a list-ish value to ``list[str]``, dropping only blank entries.

    A bare string is wrapped in a one-element list rather than exploded into characters.
    Entry text is otherwise untouched -- including the leading ``\u2022`` on ``farmer_tips``.
    """
    if value is None:
        return []
    if isinstance(value, str):
        text = value.strip()
        return [text] if text else []
    if isinstance(value, Mapping):
        return [_as_str(item) for item in value.values() if _as_str(item)]
    if isinstance(value, (list, tuple)):
        return [_as_str(item) for item in value if _as_str(item)]
    return [_as_str(value)]


def _as_item_list(value: Any) -> list[dict[str, Any]]:
    """Coerce a list of ``{name, purpose, ...}`` objects to ``list[dict[str, Any]]``.

    Keys are normalised to strings and values are left as they are, so an unexpected key
    survives into ``FertilizerItemOut`` / ``TreatmentItemOut`` (both allow extras). A
    stray plain string degrades to ``{"name": ...}`` instead of raising.
    """
    if value is None:
        return []
    if isinstance(value, Mapping):
        value = [value]
    if isinstance(value, str):
        text = value.strip()
        return [{"name": text}] if text else []
    if not isinstance(value, (list, tuple)):
        return []

    items: list[dict[str, Any]] = []
    for entry in value:
        if isinstance(entry, Mapping):
            item = {str(key): entry[key] for key in entry}
            if any(item.get(key) for key in item):
                items.append(item)
        elif entry is not None:
            text = _as_str(entry)
            if text:
                items.append({"name": text})
    return items


def _is_empty(value: Any) -> bool:
    """Emptiness for the view's field-dropping rule.

    ``bool`` is never empty: ``is_healthy=False`` is a stated diagnosis, not a missing
    value, so it survives the drop.
    """
    if isinstance(value, bool):
        return False
    if value is None:
        return True
    if isinstance(value, str):
        return not value.strip()
    if isinstance(value, (list, tuple, dict, set)):
        return len(value) == 0
    return False


def _canonical(text: str) -> str:
    """Case- and whitespace-insensitive key for counting distinct crops and pairs."""
    return " ".join(text.split()).casefold()


# --- the record -------------------------------------------------------------------------


class Recommendation(BaseModel):
    """One guidance record: the 17 data fields plus ``is_placeholder``.

    Internal to the backend. Every field defaults to an empty value and every input is
    coerced before validation, so a record that omits a key loads with that key empty
    rather than failing the whole store. ``extra="ignore"`` means a new key in the data
    files is dropped here instead of raising -- add it to the field list to surface it.

    ``frozen=True`` blocks attribute assignment; the list fields are ordinary lists, so
    treat them as read-only by convention (nothing in the application mutates them).
    """

    model_config = ConfigDict(extra="ignore", frozen=True)

    crop: str = ""
    crop_hindi: str = ""
    disease: str = ""
    is_healthy: bool = False
    description: str = ""
    cause: str = ""
    affected_parts: list[str] = Field(default_factory=list)
    symptoms: list[str] = Field(default_factory=list)
    organic_remedy: list[str] = Field(default_factory=list)
    chemical_spray: list[str] = Field(default_factory=list)
    preventive_measures: list[str] = Field(default_factory=list)
    prevention: list[str] = Field(default_factory=list)
    best_time_to_spray: str = ""
    fertilizers: list[dict[str, Any]] = Field(default_factory=list)
    safety_tips: list[str] = Field(default_factory=list)
    farmer_tips: list[str] = Field(default_factory=list)
    treatment: list[dict[str, Any]] = Field(default_factory=list)

    is_placeholder: bool = False
    """True only for the resolver's fallback record (Req 7.8); never set from the data."""

    @field_validator(*STRING_FIELDS, mode="before")
    @classmethod
    def _coerce_str(cls, value: Any) -> str:
        return _as_str(value)

    @field_validator("is_healthy", "is_placeholder", mode="before")
    @classmethod
    def _coerce_bool(cls, value: Any) -> bool:
        return _as_bool(value)

    @field_validator(*TEXT_LIST_FIELDS, mode="before")
    @classmethod
    def _coerce_text_list(cls, value: Any) -> list[str]:
        return _as_text_list(value)

    @field_validator(*ITEM_LIST_FIELDS, mode="before")
    @classmethod
    def _coerce_item_list(cls, value: Any) -> list[dict[str, Any]]:
        return _as_item_list(value)

    @property
    def pair(self) -> tuple[str, str]:
        """The record's ``(crop, disease)`` pair as written in the data."""
        return self.crop, self.disease

    def data_fields(self) -> dict[str, Any]:
        """The 17 data fields only, in requirement order (``is_placeholder`` excluded)."""
        return {name: getattr(self, name) for name in RECOMMENDATION_FIELDS}

    def view(
        self,
        *,
        source_key: str | None = None,
        resolution_stage: str = "exact",
    ) -> RecommendationView:
        """Wrap this record in its presentation view."""
        return RecommendationView(
            record=self,
            source_key=source_key,
            resolution_stage=resolution_stage,
        )


# --- the view ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class RecommendationView:
    """Presentation projection of a :class:`Recommendation`.

    Does two things and nothing else:

    * **Collapses the duplicate prevention list.** When ``prevention`` equals
      ``preventive_measures`` the view reports ``prevention == []`` and keeps
      ``preventive_measures`` intact, so the UI renders one heading, not two identical
      ones. When they differ, both are reported unchanged -- the collapse can never drop
      a list that carries distinct advice.
    * **Drops empty fields** in :meth:`visible_fields`, so a renderer can iterate what is
      there instead of testing each field. Booleans are kept regardless of value.

    ``source_key`` is the Recommendation_Store key the record came from, ``None`` for the
    placeholder. ``resolution_stage`` is the resolver stage that found it
    (``exact | normalized | pair | alias | placeholder``); both are carried here because
    the wire model reports them alongside the guidance.
    """

    record: Recommendation
    source_key: str | None = None
    resolution_stage: str = "exact"

    @classmethod
    def of(
        cls,
        record: Recommendation,
        *,
        source_key: str | None = None,
        resolution_stage: str = "exact",
    ) -> RecommendationView:
        """Build a view for ``record``."""
        return cls(record=record, source_key=source_key, resolution_stage=resolution_stage)

    # --- the prevention collapse ---

    @property
    def prevention_collapsed(self) -> bool:
        """True when ``prevention`` duplicates ``preventive_measures`` element for element.

        Both empty is not a collapse: there is nothing to hide, and reporting a collapse
        would suggest content exists under the other heading.
        """
        prevention = self.record.prevention
        return bool(prevention) and prevention == self.record.preventive_measures

    @property
    def preventive_measures(self) -> list[str]:
        """``preventive_measures`` as stored -- the collapse never touches this side."""
        return list(self.record.preventive_measures)

    @property
    def prevention(self) -> list[str]:
        """``prevention``, or ``[]`` when it duplicates ``preventive_measures``."""
        return [] if self.prevention_collapsed else list(self.record.prevention)

    # --- field projections ---

    def fields(self) -> dict[str, Any]:
        """All 17 fields in requirement order, with the prevention collapse applied."""
        values = self.record.data_fields()
        values["prevention"] = self.prevention
        return values

    def visible_fields(self) -> dict[str, Any]:
        """:meth:`fields` minus every empty value.

        ``prevention`` disappears here when it was collapsed, since the collapse makes it
        empty. ``is_healthy`` is always present.
        """
        return {name: value for name, value in self.fields().items() if not _is_empty(value)}

    def is_present(self, name: str) -> bool:
        """Whether ``name`` survives :meth:`visible_fields`."""
        return name in self.visible_fields()

    def to_out(self) -> RecommendationOut:
        """Project into the wire model ``app.schemas.RecommendationOut`` (Req 7.9).

        The wire model keeps every key present with an empty default, so this fills all of
        them; ``prevention`` arrives as ``[]`` when it was collapsed. ``crop``,
        ``crop_hindi``, ``disease`` and ``is_healthy`` are not part of
        ``RecommendationOut`` -- they belong to ``DiagnosisOut`` -- so they are not sent
        twice.
        """
        record = self.record
        return RecommendationOut(
            source_key=self.source_key,
            resolution_stage=self.resolution_stage,
            is_placeholder=record.is_placeholder,
            description=record.description,
            cause=record.cause,
            best_time_to_spray=record.best_time_to_spray,
            symptoms=list(record.symptoms),
            affected_parts=list(record.affected_parts),
            organic_remedy=list(record.organic_remedy),
            chemical_spray=list(record.chemical_spray),
            preventive_measures=self.preventive_measures,
            prevention=self.prevention,
            safety_tips=list(record.safety_tips),
            farmer_tips=list(record.farmer_tips),
            fertilizers=[FertilizerItemOut.model_validate(item) for item in record.fertilizers],
            treatment=[TreatmentItemOut.model_validate(item) for item in record.treatment],
        )


# --- metadata ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class StoreMetadata:
    """The Home page coverage figures (Req 2.2), all derived from the loaded records.

    Measured against the current data files: 32 crops, 133 classes, 30 healthy classes,
    140 records. Those numbers are documentation of a measurement, not inputs -- a data
    change moves them without a code change.

    A *class* is a distinct canonical ``(crop, disease)`` pair, compared case- and
    whitespace-insensitively. It is 133 rather than 140 because the merged data holds
    near-duplicate keys for the same real class (``Cotton_Healthy_Leaf`` /
    ``Cotton_Healthy_Plant``, ``Pepper`` / ``Bell Pepper``). ``healthy_class_count``
    counts distinct healthy pairs (30) while ``healthy_record_count`` counts healthy
    records (32); the two differ by exactly those duplicates.
    """

    crops: list[str]
    crop_count: int
    class_count: int
    healthy_class_count: int
    healthy_record_count: int
    record_count: int

    def as_dict(self) -> dict[str, Any]:
        """The figures as a plain mapping, for the metadata route and the startup log."""
        return {
            "crops": list(self.crops),
            "crop_count": self.crop_count,
            "class_count": self.class_count,
            "healthy_class_count": self.healthy_class_count,
            "healthy_record_count": self.healthy_record_count,
            "recommendation_count": self.record_count,
        }


def _compute_metadata(records: Mapping[str, Recommendation]) -> StoreMetadata:
    """Derive every coverage figure from the merged records (Req 2.2)."""
    crop_display: dict[str, str] = {}
    pairs: set[tuple[str, str]] = set()
    healthy_pairs: set[tuple[str, str]] = set()
    healthy_records = 0

    for record in records.values():
        crop = record.crop.strip()
        if crop:
            # First spelling seen wins the display form; the key dedupes "Bell Pepper"
            # from "bell  pepper" without inventing a new label for the UI.
            crop_display.setdefault(_canonical(crop), crop)

        pair = (_canonical(record.crop), _canonical(record.disease))
        if any(pair):
            pairs.add(pair)
            if record.is_healthy:
                healthy_pairs.add(pair)
        if record.is_healthy:
            healthy_records += 1

    crops = sorted(crop_display.values(), key=str.casefold)
    return StoreMetadata(
        crops=crops,
        crop_count=len(crops),
        class_count=len(pairs),
        healthy_class_count=len(healthy_pairs),
        healthy_record_count=healthy_records,
        record_count=len(records),
    )


# --- the store --------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class RecommendationStore:
    """The merged 140-record store, built once at startup and read-only afterwards.

    ``sources`` is exactly the two files that were opened, which is what a test asserts
    against to prove the excluded files were never read (Req 7.2).
    """

    records: dict[str, Recommendation]
    sources: tuple[Path, ...]
    metadata: StoreMetadata

    def __len__(self) -> int:
        return len(self.records)

    def __contains__(self, key: object) -> bool:
        return key in self.records

    def __iter__(self) -> Iterator[str]:
        return iter(self.records)

    def get(self, key: str) -> Recommendation | None:
        """The record stored under ``key`` verbatim, or ``None``. No fuzzy matching here.

        Normalisation, ``(crop, disease)`` pairs and aliases are the label resolver's job;
        this store is the plain dictionary it indexes.
        """
        return self.records.get(key)

    def keys(self) -> list[str]:
        """Store keys in merge order: the 91 base keys, then the 49 extension keys."""
        return list(self.records)

    def items(self) -> list[tuple[str, Recommendation]]:
        """``(key, record)`` pairs in merge order."""
        return list(self.records.items())

    def values(self) -> list[Recommendation]:
        """Records in merge order."""
        return list(self.records.values())

    def view(self, key: str, *, resolution_stage: str = "exact") -> RecommendationView | None:
        """A :class:`RecommendationView` for ``key``, or ``None`` when it is unknown."""
        record = self.records.get(key)
        if record is None:
            return None
        return RecommendationView.of(record, source_key=key, resolution_stage=resolution_stage)


# --- loading ----------------------------------------------------------------------------


def _read_json_object(path: Path, *, what: str) -> dict[str, Any]:
    """Read a JSON object from ``path`` as UTF-8, with startup-legible failures."""
    try:
        text = Path(path).read_text(encoding="utf-8")
    except FileNotFoundError as exc:
        raise RecommendationDataError(f"{what} file not found: {path}") from exc
    except OSError as exc:
        raise RecommendationDataError(f"{what} file could not be read: {path}") from exc
    except UnicodeDecodeError as exc:  # pragma: no cover - guarded by encoding="utf-8"
        raise RecommendationDataError(f"{what} file is not valid UTF-8: {path}") from exc

    try:
        raw = json.loads(text)
    except json.JSONDecodeError as exc:
        raise RecommendationDataError(
            f"{what} file is not valid JSON: {path} ({exc.msg})"
        ) from exc

    if not isinstance(raw, dict):
        raise RecommendationDataError(
            f"{what} file must be a JSON object keyed by class name, "
            f"got {type(raw).__name__}: {path}"
        )
    return raw


def load_disease_info(path: Path, *, what: str = "recommendation data") -> dict[str, Recommendation]:
    """Load one recommendation file into ``{key: Recommendation}``.

    Args:
        path: ``Settings.disease_info_path`` or ``Settings.disease_info_ext_path``. No
            other path is ever passed here by application code.
        what: label used in error and log messages.

    Returns:
        Records in file order, so the merge preserves it.

    Raises:
        RecommendationDataError: the file is missing, unreadable, not JSON, not a JSON
            object, or holds an entry that is not an object.

    Missing fields inside an otherwise valid record are logged at WARNING and default to
    empty; that keeps one hand-authored gap from taking down the whole store.
    """
    raw = _read_json_object(path, what=what)

    records: dict[str, Recommendation] = {}
    for key, entry in raw.items():
        if not isinstance(entry, Mapping):
            raise RecommendationDataError(
                f"{what} entry {key!r} must be an object, got {type(entry).__name__}: {path}"
            )

        missing = [name for name in RECOMMENDATION_FIELDS if name not in entry]
        if missing:
            log.warning(
                "%s record %r is missing %d field(s) %s; defaulting them to empty",
                what,
                key,
                len(missing),
                missing,
            )

        records[str(key)] = Recommendation.model_validate(dict(entry))

    log.debug("loaded %d %s records from %s", len(records), what, path)
    return records


def build_recommendation_store(settings: Settings | None = None) -> RecommendationStore:
    """Build the Recommendation_Store from the two permitted files (Req 7.1, 7.2, 2.2).

    ``disease_info.json`` is loaded first and wins any key collision -- it is the
    canonical base the EfficientNet vocabulary matches one-to-one. As measured the two
    key sets are disjoint, so today the rule never fires; a collision is logged at
    WARNING so a future data edit that introduces one is visible rather than silent.

    Args:
        settings: defaults to :func:`app.config.get_settings`. Only
            ``disease_info_path`` and ``disease_info_ext_path`` are read, which is what
            makes the excluded files unreachable.

    Returns:
        A :class:`RecommendationStore` with 140 records and its metadata computed.

    Raises:
        RecommendationDataError: either file is missing or structurally unusable.
    """
    cfg = settings or get_settings()
    base_path = cfg.disease_info_path
    ext_path = cfg.disease_info_ext_path

    base = load_disease_info(base_path, what="disease_info")
    extension = load_disease_info(ext_path, what="disease_info_ext")

    collisions = [key for key in extension if key in base]
    if collisions:
        log.warning(
            "%d recommendation key(s) appear in both data files; keeping the "
            "disease_info.json record for %s",
            len(collisions),
            sorted(collisions)[:10],
        )

    records: dict[str, Recommendation] = dict(base)
    for key, record in extension.items():
        if key in records:
            continue  # base wins
        records[key] = record

    metadata = _compute_metadata(records)
    store = RecommendationStore(
        records=records,
        sources=(base_path, ext_path),
        metadata=metadata,
    )

    if len(records) != EXPECTED_RECORD_COUNT:
        log.warning(
            "recommendation store holds %d records, expected %d "
            "(%d base + %d extension - %d collision(s)); the data files may have changed",
            len(records),
            EXPECTED_RECORD_COUNT,
            len(base),
            len(extension),
            len(collisions),
        )

    log.info(
        "recommendation store built: records=%d crops=%d classes=%d healthy_classes=%d "
        "(base=%d ext=%d collisions=%d)",
        metadata.record_count,
        metadata.crop_count,
        metadata.class_count,
        metadata.healthy_class_count,
        len(base),
        len(extension),
        len(collisions),
    )
    return store


@lru_cache(maxsize=1)
def get_recommendation_store() -> RecommendationStore:
    """The process-wide store, built on first use.

    Startup calls this once so the files are read before the first request. Tests that
    point settings elsewhere should call :func:`reset_recommendation_store` first.
    """
    return build_recommendation_store()


def reset_recommendation_store() -> None:
    """Drop the cached store so the next :func:`get_recommendation_store` rebuilds it."""
    get_recommendation_store.cache_clear()
