"""The Crop_Index: which class indices belong to which crop, computed once at startup.

``POST /api/predict`` accepts an optional ``crop`` form field. When the user has told
the UI which crop they are photographing, the answer should be constrained to that
crop's classes rather than to all 91 -- a Tomato leaf cannot be Apple scab, and the
reported confidence is far more useful as a probability *within* Tomato than as a
fraction of the whole vocabulary.

Doing that per request would mean 91 resolver calls per model per upload. So this
module builds the whole lookup once, alongside the Label_Resolver in startup step 5,
in exactly the shape the masking needs:

``{normalized_crop: {model_id: (class indices...)}}``

Three details worth knowing before editing:

* **The user's string is normalised, never trusted verbatim.** :func:`
  app.services.label_resolver.normalize` is reused, so case, spaces, commas, parentheses
  and underscore runs all stop mattering and the frontend can send whatever spelling its
  dropdown holds.
* **A class is filed under its recommendation record's crop, with the label map's
  spelling kept as an alias.** ``RecommendationStore.metadata.crops`` (32 entries as
  measured) is the canonical list, and it is the list a UI dropdown is built from, so it
  has to be the list a hint can be *expressed* in. The label maps disagree with it in
  five measured places, and normalisation cannot bridge any of them:

  | vocabulary   | label map spelling        | store crop     |
  |--------------|---------------------------|----------------|
  | ViT          | ``Corn``                  | Corn (Maize)   |
  | ViT          | ``Gauva``                 | Guava          |
  | ViT          | ``Pepper_bell``           | Pepper         |
  | EfficientNet | ``Corn_(maize)``          | Corn (Maize)   |
  | EfficientNet | ``Cherry_(including_sour)`` | Cherry       |
  | EfficientNet | ``Pepper,_bell``          | Bell Pepper    |

  Keying on the label map alone would split Corn across two entries -- the ViT half
  under ``corn`` and the EfficientNet half under ``cornmaize`` -- and would leave
  ``Guava`` and ``Cherry``, both real dropdown values, matching nothing at all. So the
  crop of a class is the crop of the record the diagnosis will cite (which the
  Label_Resolver already bridges through its four stages), and the label map's own
  spelling is registered as an alias pointing at the same entry. ``"Corn (Maize)"``,
  ``"corn_maize"``, ``"Corn"`` and ``"corn"`` therefore all reach one filter holding both
  vocabularies' corn classes, and ``meta.crop_filter`` reports the store's spelling.
* **``Pepper`` and ``Bell Pepper`` stay separate**, because the store itself keeps two
  records for that one real crop (the same near-duplication its ``class_count`` of 133
  against 140 records records). A hint of either one masks the vocabulary that holds
  those classes and leaves the other model unconstrained. Merging them here would be
  inventing an equivalence the data does not state; the fix belongs in the data files.
* **A class with no discoverable crop is simply not indexed.** It stays reachable through
  unconstrained inference; it just cannot be selected by a crop hint. Silently dropping
  it is right: guessing a crop here would mask the wrong classes, and a hint is a
  convenience, never a filter the user can be harmed by.

Indices are positions in that model's own ``labels`` list, which is the model's output
order (see :mod:`app.services.label_maps`), so they can be used directly against a logit
vector. The two vocabularies are ordered differently and their index sets are kept apart
per ``model_id`` for that reason.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from functools import lru_cache

from ..logging_config import get_logger
from .label_maps import LabelMaps, load_label_maps
from .label_resolver import (
    EFFNET_MODEL_ID,
    VIT_MODEL_ID,
    LabelResolver,
    get_label_resolver,
    normalize,
)
from .recommendations import RecommendationStore, get_recommendation_store

__all__ = [
    "INDEXED_MODEL_IDS",
    "CropFilter",
    "CropIndex",
    "build_crop_index",
    "get_crop_index",
    "reset_crop_index",
]

log = get_logger(__name__)

INDEXED_MODEL_IDS: tuple[str, ...] = (VIT_MODEL_ID, EFFNET_MODEL_ID)
"""The models whose vocabularies are indexed, primary first (cascade order)."""


@dataclass(frozen=True, slots=True)
class CropFilter:
    """One crop's class indices, per model.

    Attributes:
        crop: the canonical display spelling, as ``meta.crop_filter`` reports it.
        normalized: :func:`~app.services.label_resolver.normalize` of ``crop``; the key
            this filter is stored under.
        indices: ``{model_id: (index, ...)}``, ascending, deduplicated. A model whose
            vocabulary holds no class for this crop is absent rather than empty, and
            :meth:`for_model` reports ``()`` for both cases.
    """

    crop: str
    normalized: str
    indices: dict[str, tuple[int, ...]]

    def for_model(self, model_id: str) -> tuple[int, ...]:
        """Class indices of this crop in ``model_id``'s vocabulary, possibly empty."""
        return self.indices.get(model_id, ())

    def covers(self, model_id: str) -> bool:
        """Whether ``model_id`` has at least one class for this crop."""
        return bool(self.for_model(model_id))

    def class_counts(self) -> dict[str, int]:
        """``{model_id: number of classes}``, for logging and health-style summaries."""
        return {model_id: len(indices) for model_id, indices in self.indices.items()}


@dataclass(frozen=True, slots=True)
class CropIndex:
    """The whole crop lookup, read-only after construction.

    Two dictionaries: ``filters`` keyed by the normalised *store* crop, and ``aliases``
    mapping a normalised label-map spelling onto one of those keys. Built once by
    :func:`build_crop_index` and parked on ``app.state.crop_index``; :meth:`resolve`
    mutates nothing, so it is safe to call from FastAPI's worker threads.
    """

    filters: dict[str, CropFilter]
    aliases: dict[str, str] = field(default_factory=dict)

    def resolve(self, crop: str | None) -> CropFilter | None:
        """The filter for ``crop``, matched tolerantly, or ``None`` when unknown.

        Never raises: ``None``, ``""``, whitespace and unicode junk all return ``None``,
        which the caller treats as "no hint" and answers unconstrained.

        Examples (against the real data):
            ``"Tomato"``, ``"tomato"`` and ``"  TOMATO "`` all reach the Tomato filter;
            ``"Corn (Maize)"``, ``"corn_maize"``, ``"Corn"`` and ``"corn"`` all reach the
            one Corn (Maize) filter; ``"Gauva"`` reaches Guava.
        """
        key = normalize(crop)
        if not key:
            return None
        matched = self.filters.get(key)
        if matched is not None:
            return matched
        aliased = self.aliases.get(key)
        return self.filters.get(aliased) if aliased else None

    def crops(self) -> list[str]:
        """The canonical crop names this index can constrain to, case-insensitively sorted."""
        return sorted((f.crop for f in self.filters.values()), key=str.casefold)

    def __len__(self) -> int:
        return len(self.filters)

    def __contains__(self, crop: object) -> bool:
        return self.resolve(crop if isinstance(crop, str) else None) is not None


# --- construction -----------------------------------------------------------------------


def _label_map_crop(label: str, model_id: str, label_maps: LabelMaps) -> str:
    """The crop this label's own vocabulary claims, or ``""``.

    ``""`` for the 53 bare EfficientNet labels (``Hispa``, ``Black Rot``), which carry no
    ``___`` separator and therefore no crop, and for any ViT entry with a blank ``crop``.
    """
    if model_id == VIT_MODEL_ID:
        meta = label_maps.vit_meta.get(label)
        return (meta.crop if meta is not None else "").strip()
    parts = label_maps.effnet_parts.get(label)
    return ((parts.crop if parts is not None else None) or "").strip()


def _store_crop(label: str, model_id: str, resolver: LabelResolver) -> str:
    """The crop of the record this label resolves to, or ``""`` for the placeholder.

    This is the canonical spelling: it is the same record the diagnosis will cite, so the
    index can never disagree with the response it constrains.
    """
    record = resolver.resolve_prediction(label, model_id).record
    if record.is_placeholder:
        return ""
    return record.crop.strip()


def build_crop_index(
    store: RecommendationStore | None = None,
    label_maps: LabelMaps | None = None,
    resolver: LabelResolver | None = None,
) -> CropIndex:
    """Build the crop index from the store's canonical crop list and both vocabularies.

    Args:
        store: the merged Recommendation_Store; its ``metadata.crops`` supplies the
            canonical display spellings and the set a hint may name. Defaults to the
            cached store.
        label_maps: both vocabularies. Defaults to the resolver's own maps, then to a
            fresh load.
        resolver: maps each label onto the record whose crop the class is filed under,
            and whose own spelling becomes an alias. Defaults to the cached
            process-wide resolver.

    Returns:
        A :class:`CropIndex`. Startup passes all three arguments so nothing is built or
        read twice.
    """
    active_resolver = resolver if resolver is not None else get_label_resolver()
    active_store = store if store is not None else (
        active_resolver.store or get_recommendation_store()
    )
    maps = label_maps or active_resolver.label_maps or load_label_maps()

    # Canonical spellings first, so the store's own casing wins over a label map's.
    names: dict[str, str] = {}
    for crop in active_store.metadata.crops:
        key = normalize(crop)
        if key:
            names.setdefault(key, crop.strip())

    indices: dict[str, dict[str, list[int]]] = {}
    alias_targets: dict[str, str] = {}
    unindexed: dict[str, list[str]] = {}

    for model_id in INDEXED_MODEL_IDS:
        labels = maps.labels_for(model_id)
        for index, label in enumerate(labels):
            map_crop = _label_map_crop(label, model_id, maps)
            crop = _store_crop(label, model_id, active_resolver) or map_crop
            key = normalize(crop)
            if not key:
                unindexed.setdefault(model_id, []).append(label)
                continue

            names.setdefault(key, crop)
            indices.setdefault(key, {}).setdefault(model_id, []).append(index)

            alias = normalize(map_crop)
            if alias and alias != key:
                alias_targets.setdefault(alias, key)

    filters = {
        key: CropFilter(
            crop=names.get(key, key),
            normalized=key,
            indices={
                model_id: tuple(sorted(set(values)))
                for model_id, values in per_model.items()
            },
        )
        for key, per_model in indices.items()
    }

    # An alias may never shadow a crop that is itself indexed: "cherry" is both a store
    # crop and a ViT label-map spelling, and the store must win.
    aliases = {
        alias: target
        for alias, target in alias_targets.items()
        if alias not in filters and target in filters
    }

    for model_id, labels in unindexed.items():
        log.warning(
            "crop index: %d %s label(s) carry no crop and cannot be crop-constrained, "
            "e.g. %s",
            len(labels),
            model_id,
            labels[:5],
        )

    uncovered = sorted(key for key in names if key not in filters)
    if uncovered:
        log.info(
            "crop index: %d known crop(s) have no class in either vocabulary: %s",
            len(uncovered),
            [names[key] for key in uncovered],
        )

    partial = sorted(
        f.crop
        for f in filters.values()
        if not all(f.covers(model_id) for model_id in INDEXED_MODEL_IDS)
    )
    if partial:
        # Expected: the two vocabularies cover different crop sets (13 in both, 11 ViT
        # only, 8 EfficientNet only as measured). A hint for one of these masks the model
        # that has the classes and leaves the other unconstrained.
        log.info(
            "crop index: %d crop(s) appear in only one vocabulary: %s",
            len(partial),
            partial,
        )

    log.info(
        "crop index built: %d crop(s) indexed, %d alias(es) (%s)",
        len(filters),
        len(aliases),
        " ".join(
            f"{model_id}={sum(len(f.for_model(model_id)) for f in filters.values())}"
            for model_id in INDEXED_MODEL_IDS
        ),
    )
    return CropIndex(filters=filters, aliases=aliases)


@lru_cache(maxsize=1)
def get_crop_index() -> CropIndex:
    """The process-wide crop index, built on first use.

    Startup builds it explicitly from the objects it already has; this cached getter is
    the fallback for an app constructed without its lifespan.
    """
    return build_crop_index()


def reset_crop_index() -> None:
    """Drop the cached index so the next :func:`get_crop_index` rebuilds it."""
    get_crop_index.cache_clear()
