"""The Label_Resolver: any predicted label from either vocabulary to exactly one record.

The two checkpoints speak different label languages. EfficientNet emits
``Apple___Apple_scab``; the ViT emits ``Apple__scab``. The Recommendation_Store is keyed
in both styles at once (91 base keys in the EfficientNet style, 49 extension keys in the
ViT style), so a single dictionary lookup answers most questions and a short ladder of
fallbacks answers the rest.

Requirement 7.5 fixes the ladder and its order:

1. **exact** -- the label is a store key verbatim.
2. **normalized** -- ``normalize(label)`` matches ``normalize(store key)``: lowercase with
   every non-alphanumeric character dropped, so ``Apple__black_rot`` reaches
   ``Apple___Black_rot``.
3. **pair** -- the normalised ``(crop, disease)`` hint matches a record's own normalised
   ``(crop, disease)``. The hint comes from the ViT label map for a ViT prediction and
   from the ``___`` split for an EfficientNet one.
4. **alias** -- one of the 11 hand-authored entries in :data:`ALIAS_TABLE`, which are
   exactly the labels the first three stages cannot reach.

Order is load-bearing, not a performance detail. A label that is itself a store key
resolves to *its own* record even when a later stage would map it somewhere else
(``Coffee_Rust`` and ``Coffee__rust`` are both real keys), which is also why the index
shadowings recorded below are harmless.

Measured over the full 182-label union, and asserted by the test suite so a data-file edit
that pushes a label onto a later stage fails the build:

| Label map        | exact | normalized | pair | alias | unresolved |
|------------------|-------|------------|------|-------|------------|
| EfficientNet (91)|    91 |          0 |    0 |     0 |          0 |
| ViT (91)         |    49 |         23 |    8 |    11 |          0 |

Two invariants this module guarantees to its callers (Req 7.8):

* :meth:`LabelResolver.resolve` never raises and never returns ``None``. Any input -- empty
  string, whitespace, unicode, adversarial junk -- yields a :class:`Resolution`. A miss is
  logged at WARNING and carries :data:`PLACEHOLDER`, a complete 17-field record with
  ``is_placeholder=True``, so no consumer needs a null check.
* Resolution is deterministic. The indexes are built once and never mutated, so the same
  input always produces the same stage and the same record.

This module reads the Recommendation_Store and the label maps; it opens no files of its
own, so Requirement 7.2's "only two data files" property is upheld upstream.
"""

from __future__ import annotations

import re
from collections import Counter
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from functools import lru_cache
from typing import Any

from ..logging_config import get_logger
from .label_maps import LabelMaps, load_label_maps
from .recommendations import (
    Recommendation,
    RecommendationStore,
    RecommendationView,
    get_recommendation_store,
)

__all__ = [
    "STAGES",
    "STAGE_EXACT",
    "STAGE_NORMALIZED",
    "STAGE_PAIR",
    "STAGE_ALIAS",
    "STAGE_PLACEHOLDER",
    "ALIAS_TABLE",
    "PLACEHOLDER",
    "VIT_MODEL_ID",
    "EFFNET_MODEL_ID",
    "normalize",
    "titleize",
    "is_vit_model",
    "Resolution",
    "Shadowed",
    "LabelResolver",
    "nonzero_stages",
    "empty_histogram",
    "histogram_of",
    "build_label_resolver",
    "get_label_resolver",
    "reset_label_resolver",
]

log = get_logger(__name__)

STAGE_EXACT = "exact"
STAGE_NORMALIZED = "normalized"
STAGE_PAIR = "pair"
STAGE_ALIAS = "alias"
STAGE_PLACEHOLDER = "placeholder"

STAGES: tuple[str, ...] = (
    STAGE_EXACT,
    STAGE_NORMALIZED,
    STAGE_PAIR,
    STAGE_ALIAS,
    STAGE_PLACEHOLDER,
)
"""The four resolution stages in attempt order, plus the miss outcome. This is also the
order histograms are rendered in, and it matches ``logging_config._STAGE_ORDER``."""

VIT_MODEL_ID = "vit_b16"
EFFNET_MODEL_ID = "efficientnet_b3"

_NON_ALNUM = re.compile(r"[^a-z0-9]")


def normalize(s: str | None) -> str:
    """Lowercase ``s`` and drop every character that is not ``a-z`` or ``0-9``.

    This is the whole of stage 2 and half of stage 3: it erases the difference between
    ``___``, ``__``, ``_``, spaces, commas, parentheses and case, which is exactly the set
    of differences between the two label styles.

    Non-ASCII characters are dropped rather than transliterated, so a purely non-ASCII
    label normalises to ``""`` and simply misses every index. ``None`` and non-strings are
    accepted and coerced, because this function sits on the never-raises path (Req 7.8).

    Examples:
        >>> normalize("Apple___Apple_scab")
        'appleapplescab'
        >>> normalize("Corn_(maize)___Common_rust_")
        'cornmaizecommonrust'
        >>> normalize(None)
        ''
    """
    if s is None:
        return ""
    if not isinstance(s, str):
        s = str(s)
    return _NON_ALNUM.sub("", s.lower())


def titleize(label: str | None) -> str:
    """Render a raw label as a human-readable name, for the last display-name fallback.

    Separators become spaces and each word gets its first letter capitalised; a word that
    already carries an uppercase letter is left alone, so ``ViT`` or ``DNA`` inside a label
    survives instead of being flattened by :meth:`str.title`.

    Examples:
        >>> titleize("Tomato___Late_blight")
        'Tomato Late Blight'
        >>> titleize("Corn_(maize)___Common_rust_")
        'Corn (maize) Common Rust'
        >>> titleize("")
        ''
    """
    if not label:
        return ""
    if not isinstance(label, str):
        label = str(label)
    spaced = re.sub(r"[_\-]+", " ", label)
    words = spaced.split()
    if not words:
        return ""
    return " ".join(word if any(ch.isupper() for ch in word) else word.capitalize() for word in words)


def is_vit_model(model_id: str | None) -> bool:
    """Whether ``model_id`` names the ViT, the only model with a ``display_name`` map."""
    return bool(model_id) and "vit" in str(model_id).lower()


# --- the Alias_Table --------------------------------------------------------------------

ALIAS_TABLE: dict[str, str] = {
    # disease recorded as "Cedar Apple Rust", not "rust"
    "Apple__rust": "Apple___Cedar_apple_rust",
    # disease recorded as "Apple Scab" -> pair (apple, applescab) != (apple, scab)
    "Apple__scab": "Apple___Apple_scab",
    # crop is "Corn (Maize)" -> cornmaize != corn
    "Corn__common_rust": "Corn_(maize)___Common_rust_",
    # crop name plus a compound key
    "Corn__gray_leaf_spot": "Corn_(maize)___Cercospora_leaf_spot Gray_leaf_spot",
    # crop name mismatch
    "Corn__healthy": "Corn_(maize)___healthy",
    # crop name mismatch
    "Corn__northern_leaf_blight": "Corn_(maize)___Northern_Leaf_Blight",
    # disease recorded as "Esca (Black Measles)"
    "Grape__black_measles": "Grape___Esca_(Black_Measles)",
    # disease recorded as "Rice Hispa" -> ricehispa != hispa
    "Rice__hispa": "Hispa",
    # disease recorded as "Yellow Mosaic Virus"
    "Soybean__mosaic_virus": "Yellow Mosaic",
    # disease recorded as "Tomato Mosaic Virus"
    "Tomato__mosaic_virus": "Tomato___Tomato_mosaic_virus",
    # disease recorded as "Tomato Yellow Leaf Curl Virus"
    "Tomato__yellow_leaf_curl_virus": "Tomato___Tomato_Yellow_Leaf_Curl_Virus",
}
"""The 11 entries Requirement 7.6 names, and no others.

These are precisely the ViT labels that stages 1-3 cannot reach: the crop or the disease
is spelled differently enough in the data that normalisation cannot bridge it. Every target
is a real store key, which the resolver verifies at build time and a test asserts
individually. Adding a twelfth entry here means a data file changed and the earlier stages
should be re-measured first -- an alias is the last resort, not the first fix.
"""


# --- the placeholder record -------------------------------------------------------------

PLACEHOLDER = Recommendation(
    crop="Unknown",
    crop_hindi="",
    disease="Unrecognised class",
    is_healthy=False,
    description=(
        "Treatment guidance is not available for this class yet. "
        "Please confirm the diagnosis with a local agricultural expert."
    ),
    cause="",
    affected_parts=[],
    symptoms=[],
    organic_remedy=[],
    chemical_spray=[],
    preventive_measures=[],
    prevention=[],
    best_time_to_spray="",
    fertilizers=[],
    safety_tips=[],
    farmer_tips=[],
    treatment=[],
    is_placeholder=True,
)
"""The Req 7.8 fallback: a complete record, not a ``None`` and not an exception.

All 17 fields are present and typed, most of them empty, so the view, the wire model and
the renderer all treat it like any other record and only ``is_placeholder`` distinguishes
it. The steady state is that this record is never returned for a real prediction -- the
startup coverage assertion exists to prove that.
"""


# --- results ----------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class Resolution:
    """The outcome of one resolution: which record, from which key, found by which stage.

    ``key`` is the Recommendation_Store key the record came from, or ``None`` for a
    placeholder -- which is also what the ``recommendation_key`` column stores.
    """

    label: str
    key: str | None
    record: Recommendation
    stage: str

    @property
    def is_placeholder(self) -> bool:
        """True when no stage matched. Equivalent to ``stage == "placeholder"``."""
        return self.record.is_placeholder

    @property
    def crop(self) -> str:
        """The resolved record's crop (``"Unknown"`` for a placeholder)."""
        return self.record.crop

    @property
    def disease(self) -> str:
        """The resolved record's disease."""
        return self.record.disease

    def view(self) -> RecommendationView:
        """The presentation view, pre-tagged with this resolution's key and stage."""
        return RecommendationView.of(
            self.record,
            source_key=self.key,
            resolution_stage=self.stage,
        )


@dataclass(frozen=True, slots=True)
class Shadowed:
    """One index entry that lost to an earlier insertion.

    ``index`` is ``"by_norm_key"`` or ``"by_pair"``, ``token`` the normalised string or
    ``(crop, disease)`` pair they collided on. Recorded rather than merely logged so a test
    can assert the known shadowings and catch a data edit that flips a winner.
    """

    index: str
    token: str | tuple[str, str]
    winner: str
    loser: str


# --- histogram helpers ------------------------------------------------------------------


def empty_histogram() -> dict[str, int]:
    """A zeroed stage histogram with every stage present, in :data:`STAGES` order."""
    return {stage: 0 for stage in STAGES}


def nonzero_stages(histogram: Mapping[str, int]) -> dict[str, int]:
    """``histogram`` without its zero entries, order preserved.

    Handy for asserting the measured distribution without listing the stages that do not
    occur: ``nonzero_stages(h) == {"exact": 49, "normalized": 23, "pair": 8, "alias": 11}``.
    """
    return {stage: count for stage, count in histogram.items() if count}


# --- the resolver -----------------------------------------------------------------------


@dataclass(slots=True)
class LabelResolver:
    """Three indexes over the Recommendation_Store plus the four-stage ladder.

    Built once at startup from a store and (optionally) the label maps, then read-only:
    :meth:`resolve` mutates nothing, so it is safe to call from FastAPI's worker threads
    without a lock.

    Args:
        store: the merged Recommendation_Store.
        label_maps: both vocabularies. Optional -- without them :meth:`resolve` still works
            with explicitly passed hints, but :meth:`hints_for` and
            :meth:`resolve_prediction` have nothing to look a label up in.
    """

    store: RecommendationStore
    label_maps: LabelMaps | None = None

    exact: dict[str, Recommendation] = field(default_factory=dict, init=False)
    by_norm_key: dict[str, str] = field(default_factory=dict, init=False)
    by_pair: dict[tuple[str, str], str] = field(default_factory=dict, init=False)
    shadowed: list[Shadowed] = field(default_factory=list, init=False)

    def __post_init__(self) -> None:
        self._build_indexes()
        self._check_alias_targets()

    # --- index construction ---

    def _build_indexes(self) -> None:
        """Fill the three indexes in store order; first insertion wins.

        A collision is recorded in :attr:`shadowed` and logged at DEBUG rather than raised.
        It cannot change an outcome: every shadowed key is itself an exact key, and stage 1
        runs before the indexes are consulted at all.
        """
        for key, record in self.store.items():
            self.exact[key] = record

            norm = normalize(key)
            if norm:
                existing = self.by_norm_key.get(norm)
                if existing is None:
                    self.by_norm_key[norm] = key
                elif existing != key:
                    self._record_shadow("by_norm_key", norm, existing, key)

            pair = (normalize(record.crop), normalize(record.disease))
            if all(pair):
                existing = self.by_pair.get(pair)
                if existing is None:
                    self.by_pair[pair] = key
                elif existing != key:
                    self._record_shadow("by_pair", pair, existing, key)

        log.debug(
            "label resolver indexes built: exact=%d by_norm_key=%d by_pair=%d shadowed=%d",
            len(self.exact),
            len(self.by_norm_key),
            len(self.by_pair),
            len(self.shadowed),
        )

    def _record_shadow(
        self,
        index: str,
        token: str | tuple[str, str],
        winner: str,
        loser: str,
    ) -> None:
        self.shadowed.append(Shadowed(index=index, token=token, winner=winner, loser=loser))
        log.debug(
            "%s collision on %r: keeping %r, shadowing %r (both remain reachable "
            "as exact keys)",
            index,
            token,
            winner,
            loser,
        )

    def _check_alias_targets(self) -> None:
        """Warn about any alias whose target is not a store key.

        A warning, not an exception: a broken alias degrades one label to the placeholder,
        and taking the whole server down over it would be a worse trade. The startup
        coverage assertion and the resolver tests both fail loudly on it.
        """
        missing = [
            (source, target) for source, target in ALIAS_TABLE.items() if target not in self.exact
        ]
        if missing:
            log.warning(
                "%d alias target(s) are absent from the recommendation store: %s",
                len(missing),
                missing,
            )

    # --- shadowing accessors (asserted by the test suite) ---

    def shadowed_norm_keys(self) -> list[tuple[str, str, str]]:
        """``(normalized, winner_key, shadowed_key)`` for every normalised-key collision."""
        return [
            (str(item.token), item.winner, item.loser)
            for item in self.shadowed
            if item.index == "by_norm_key"
        ]

    def shadowed_pairs(self) -> list[tuple[tuple[str, str], str, str]]:
        """``((crop, disease), winner_key, shadowed_key)`` for every pair collision."""
        return [
            (item.token, item.winner, item.loser)  # type: ignore[misc]
            for item in self.shadowed
            if item.index == "by_pair"
        ]

    # --- the four stages ---

    def resolve(
        self,
        label: str,
        crop: str | None = None,
        disease: str | None = None,
    ) -> Resolution:
        """Resolve ``label`` to exactly one record (Req 7.5, 7.8).

        Args:
            label: the predicted label, as the winning model emitted it.
            crop: optional crop hint. Stage 3 is attempted only when this is truthy,
                which is what keeps the 53 bare EfficientNet names off that stage.
            disease: optional disease hint.

        Returns:
            A :class:`Resolution`. Never ``None``.

        Never raises. A label matching nothing is logged at WARNING and comes back with
        :data:`PLACEHOLDER` and stage ``placeholder``.
        """
        text = label if isinstance(label, str) else ("" if label is None else str(label))

        record = self.exact.get(text)  # stage 1
        if record is not None:
            return Resolution(label=text, key=text, record=record, stage=STAGE_EXACT)

        norm = normalize(text)
        if norm:
            key = self.by_norm_key.get(norm)  # stage 2
            if key is not None:
                return self._hit(text, key, STAGE_NORMALIZED)

        if crop:
            pair = (normalize(crop), normalize(disease))
            key = self.by_pair.get(pair)  # stage 3
            if key is not None:
                return self._hit(text, key, STAGE_PAIR)

        target = ALIAS_TABLE.get(text)  # stage 4
        if target is not None:
            record = self.exact.get(target)
            if record is not None:
                return Resolution(label=text, key=target, record=record, stage=STAGE_ALIAS)
            log.warning(
                "alias %r points at %r, which is not a recommendation store key", text, target
            )

        log.warning("unresolved label: %r", text)
        return Resolution(label=text, key=None, record=PLACEHOLDER, stage=STAGE_PLACEHOLDER)

    def _hit(self, label: str, key: str, stage: str) -> Resolution:
        """Build a Resolution for a store key an index pointed at."""
        record = self.exact.get(key)
        if record is None:  # pragma: no cover - indexes only ever hold real keys
            log.warning("index for stage %s points at unknown key %r", stage, key)
            return Resolution(label=label, key=None, record=PLACEHOLDER, stage=STAGE_PLACEHOLDER)
        return Resolution(label=label, key=key, record=record, stage=stage)

    # --- model-aware entry points ---

    def hints_for(self, label: str, model_id: str | None) -> tuple[str | None, str | None]:
        """The ``(crop, disease)`` hint stage 3 should use for ``label`` from ``model_id``.

        ViT labels take their hint from the label map, which carries ``crop`` and
        ``disease`` per entry. EfficientNet labels take theirs from the ``___`` split, where
        ``crop`` is ``None`` for the 53 bare names -- and a ``None`` crop deliberately skips
        stage 3 rather than guessing.

        Returns ``(None, None)`` when no label map is loaded or the label is unknown to it.
        """
        maps = self.label_maps
        if maps is None:
            return None, None

        if is_vit_model(model_id):
            meta = maps.vit_meta.get(label)
            if meta is not None:
                return (meta.crop or None), (meta.disease or None)
            return None, None

        parts = maps.effnet_parts.get(label)
        if parts is not None:
            return parts.crop, parts.disease

        # Model unknown or label absent from that map: try both, ViT first, so a caller
        # that passes no model id still gets whatever hint the data has.
        meta = maps.vit_meta.get(label)
        if meta is not None:
            return (meta.crop or None), (meta.disease or None)
        return None, None

    def resolve_prediction(self, label: str, model_id: str | None = None) -> Resolution:
        """Resolve a label emitted by ``model_id``, taking the stage-3 hint from its map.

        This is the request-path entry point: the caller has a label and knows which model
        produced it, and nothing else.
        """
        crop, disease = self.hints_for(label, model_id)
        return self.resolve(label, crop, disease)

    def display_name(
        self,
        label: str,
        record: Recommendation | None = None,
        model_id: str | None = None,
    ) -> str:
        """The name to show for a prediction (Req 8.2's English-first display name).

        Preference order, exactly as the design states it:

        1. the ViT label map's ``display_name``, when the ViT won -- it is the only
           curated, human-authored name in the system;
        2. the resolved record's ``disease``;
        3. a title-cased form of the raw label.

        The placeholder's ``disease`` ("Unrecognised class") is skipped in favour of the
        title-cased label, so an unresolved prediction still shows *what* was predicted and
        the placeholder notice carries the "no guidance" message.
        """
        if is_vit_model(model_id) and self.label_maps is not None:
            meta = self.label_maps.vit_meta.get(label)
            if meta is not None and meta.display_name.strip():
                return meta.display_name.strip()

        if record is not None and not record.is_placeholder and record.disease.strip():
            return record.disease.strip()

        return titleize(label) or (record.disease.strip() if record is not None else "")

    def resolve_with_display_name(
        self,
        label: str,
        model_id: str | None = None,
    ) -> tuple[Resolution, str]:
        """:meth:`resolve_prediction` plus the display name for the same label."""
        resolution = self.resolve_prediction(label, model_id)
        return resolution, self.display_name(label, resolution.record, model_id)

    # --- histogram machinery (used by the startup coverage assertion and its tests) ---

    def resolve_labels(
        self,
        labels: Iterable[str],
        model_id: str | None = None,
    ) -> list[Resolution]:
        """Resolve every label in ``labels`` as if ``model_id`` had produced it."""
        return [self.resolve_prediction(label, model_id) for label in labels]

    def stage_histogram(
        self,
        labels: Iterable[str],
        model_id: str | None = None,
    ) -> dict[str, int]:
        """Stage counts for ``labels``, every stage present in :data:`STAGES` order.

        Zeros are kept so the shape does not change with the data; use
        :func:`nonzero_stages` when only the stages that occurred are interesting.
        """
        return histogram_of(self.resolve_labels(labels, model_id))

    def unresolved(
        self,
        labels: Iterable[str],
        model_id: str | None = None,
    ) -> list[str]:
        """The labels from ``labels`` that reached the placeholder, in input order."""
        return [r.label for r in self.resolve_labels(labels, model_id) if r.is_placeholder]

    # --- convenience ---

    def keys(self) -> list[str]:
        """The store keys the exact index holds, in merge order."""
        return list(self.exact)

    def __len__(self) -> int:
        return len(self.exact)


def histogram_of(resolutions: Sequence[Resolution] | Iterable[Resolution]) -> dict[str, int]:
    """Count resolutions by stage, with every stage present in :data:`STAGES` order.

    A stage outside :data:`STAGES` (there is none today) is appended after the known ones
    rather than dropped, so a future stage cannot go unnoticed.
    """
    counts: Counter[str] = Counter(r.stage for r in resolutions)
    histogram = empty_histogram()
    for stage, count in counts.items():
        histogram[stage] = histogram.get(stage, 0) + count
    return histogram


# --- construction -----------------------------------------------------------------------


def build_label_resolver(
    store: RecommendationStore | None = None,
    label_maps: LabelMaps | None = None,
    **_: Any,
) -> LabelResolver:
    """Build the resolver, loading the store and label maps when they are not supplied.

    Args:
        store: defaults to :func:`app.services.recommendations.get_recommendation_store`.
        label_maps: defaults to :func:`app.services.label_maps.load_label_maps`.

    Returns:
        A :class:`LabelResolver` with its three indexes built.
    """
    resolved_store = store if store is not None else get_recommendation_store()
    resolved_maps = label_maps if label_maps is not None else load_label_maps()
    return LabelResolver(store=resolved_store, label_maps=resolved_maps)


@lru_cache(maxsize=1)
def get_label_resolver() -> LabelResolver:
    """The process-wide resolver, built on first use.

    Startup builds it explicitly so the indexes exist before the first request; the cache
    is what makes a second call free.
    """
    return build_label_resolver()


def reset_label_resolver() -> None:
    """Drop the cached resolver so the next :func:`get_label_resolver` rebuilds it."""
    get_label_resolver.cache_clear()
