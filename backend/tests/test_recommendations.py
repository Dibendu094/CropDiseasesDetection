"""Recommendation_Store tests (Requirements 7.1, 7.2).

**Property 12: The Recommendation_Store is exactly the merge of the two permitted sources**

*For any* build of the Recommendation_Store, its key set equals the union of the keys of
`disease_info.json` and `disease_info_ext.json` (140 keys), every record retains all 17
fields with their source values, and no key or value originates from
`disease_info.backup42.json` or `names (2).json`.

**Validates: Requirements 7.1, 7.2**

The exclusion half of the property is asserted positively, because "a file was not read"
is not directly observable:

* ``store.sources`` is exactly the two ``Settings`` paths -- those are the only two files
  the builder can open.
* the store key set equals the union of the two permitted files read here independently,
  so no key can have come from anywhere else.
* the 4 keys unique to ``disease_info.backup42.json`` (``Rice_BrownSpot``, ``Rice_Healthy``,
  ``Rice_Hispa``, ``Rice_LeafBlast``) are absent from the store. Its other 38 keys are
  shared with the permitted files and, as measured, carry byte-identical values, so they
  leave no distinguishable fingerprint -- the key-set equality above is what covers them.
  ``names (2).json`` is a flat list of 91 label strings, every one of which is already a
  ``disease_info.json`` key, so it likewise cannot be detected by its content.
* a synthetic build (:func:`test_any_build_key_set_equals_the_union_of_its_two_files`) puts
  poisoned decoy files named after both excluded files next to the two real inputs and
  asserts nothing from them reaches the store.

The `prevention`/`preventive_measures` collapse is exercised on synthetic records rather
than on the data files: with the current data the two lists are equal in **all 140**
records, so the real store cannot demonstrate the non-duplicate case at all.
"""

from __future__ import annotations

import json
import string
import tempfile
from pathlib import Path
from typing import Any

import pytest
from hypothesis import HealthCheck, given
from hypothesis import settings as hypothesis_settings
from hypothesis import strategies as st

from app.config import Settings
from app.services.recommendations import (
    BASE_RECORD_COUNT,
    EXPECTED_RECORD_COUNT,
    EXT_RECORD_COUNT,
    ITEM_LIST_FIELDS,
    RECOMMENDATION_FIELDS,
    STRING_FIELDS,
    TEXT_LIST_FIELDS,
    Recommendation,
    RecommendationStore,
    build_recommendation_store,
    load_disease_info,
)

# --- the requirement's field list, transcribed from Requirement 7 ----------
# "crop, crop_hindi, disease, is_healthy, description, cause, affected_parts, symptoms,
#  organic_remedy, chemical_spray, preventive_measures, prevention, best_time_to_spray,
#  fertilizers, safety_tips, farmer_tips, treatment"
REQUIREMENT_FIELDS: tuple[str, ...] = (
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

EXCLUDED_FILENAMES: tuple[str, ...] = ("disease_info.backup42.json", "names (2).json")
"""The two files Requirement 7.2 keeps out of the store."""

BACKUP_ONLY_KEYS: frozenset[str] = frozenset(
    {"Rice_BrownSpot", "Rice_Healthy", "Rice_Hispa", "Rice_LeafBlast"}
)
"""Measured: the keys ``disease_info.backup42.json`` holds and neither permitted file does.
Their presence in a store would prove the backup file was read."""

MEASURED_NON_EMPTY: dict[str, int] = {
    "crop": 140,
    "crop_hindi": 140,
    "disease": 140,
    "best_time_to_spray": 140,
    "affected_parts": 115,
    "symptoms": 140,
    "organic_remedy": 140,
    "chemical_spray": 108,
    "preventive_measures": 140,
    "prevention": 140,
    "fertilizers": 140,
    "safety_tips": 140,
    "farmer_tips": 140,
    "treatment": 62,
}
"""How many of the 140 records carry a non-empty value, as measured against the current
data files. ``description`` (94) and ``cause`` (133) are deliberately absent: the design's
shape table claims 140 for both, and the data disagrees. They are asserted by type only.
Emptiness is ordinary data here, not a defect -- see the module under test."""

MEASURED_METADATA: dict[str, int] = {
    "crop_count": 32,
    "class_count": 133,
    "healthy_class_count": 30,
    "healthy_record_count": 32,
    "record_count": 140,
}
"""Requirement 2.2's coverage figures as computed from the merged records."""


# --- fixtures -------------------------------------------------------------


@pytest.fixture(scope="module")
def app_settings() -> Settings:
    """Uncached settings, so the real ``data/`` paths are used without touching the cache."""
    return Settings()


@pytest.fixture(scope="module")
def raw_base(app_settings: Settings) -> dict[str, Any]:
    """``disease_info.json`` read here independently of the module under test."""
    return json.loads(app_settings.disease_info_path.read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def raw_ext(app_settings: Settings) -> dict[str, Any]:
    """``disease_info_ext.json`` read here independently of the module under test."""
    return json.loads(app_settings.disease_info_ext_path.read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def raw_merged(raw_base: dict[str, Any], raw_ext: dict[str, Any]) -> dict[str, Any]:
    """The expected merge: base first, so it wins any collision (there are none today)."""
    merged = dict(raw_base)
    for key, entry in raw_ext.items():
        merged.setdefault(key, entry)
    return merged


@pytest.fixture(scope="module")
def store(app_settings: Settings) -> RecommendationStore:
    """One real build of the Recommendation_Store, shared by the assertions below."""
    return build_recommendation_store(app_settings)


# --- helpers --------------------------------------------------------------


def expected_field_value(name: str, raw: Any) -> Any:
    """What the store should hold for source value ``raw`` of field ``name``.

    Re-derived here from the coercion the module documents (strip strings, drop blank list
    entries, keep object keys) rather than imported from it, so this stays an independent
    statement of "retains the source value".
    """
    if name in STRING_FIELDS:
        return "" if raw is None else str(raw).strip()
    if name == "is_healthy":
        return bool(raw)
    if name in TEXT_LIST_FIELDS:
        return [str(item).strip() for item in (raw or []) if str(item).strip()]
    if name in ITEM_LIST_FIELDS:
        return [{str(key): item[key] for key in item} for item in (raw or [])]
    raise AssertionError(f"unclassified field: {name}")  # pragma: no cover


def synthetic_record(key: str, origin: str) -> dict[str, Any]:
    """A minimal but complete source record, tagged with the file it came from."""
    return {
        "crop": origin,
        "crop_hindi": "आम",  # Devanagari: the read must be UTF-8, not the Windows locale
        "disease": key,
        "is_healthy": False,
        "description": f"{origin} description",
        "cause": "",
        "affected_parts": ["Leaves"],
        "symptoms": ["Spots"],
        "organic_remedy": [],
        "chemical_spray": [],
        "preventive_measures": ["Rotate crops"],
        "prevention": ["Rotate crops"],
        "best_time_to_spray": "Morning",
        "fertilizers": [{"name": "Urea", "purpose": "growth"}],
        "safety_tips": ["Wear gloves"],
        "farmer_tips": ["• Scout weekly"],
        "treatment": [],
    }


def write_json(path: Path, payload: Any) -> None:
    path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")


# --- Property 12, part 1: the key set is exactly the union ----------------


def test_source_files_have_the_measured_sizes_and_do_not_collide(
    raw_base: dict[str, Any], raw_ext: dict[str, Any]
) -> None:
    assert len(raw_base) == BASE_RECORD_COUNT == 91
    assert len(raw_ext) == EXT_RECORD_COUNT == 49
    assert set(raw_base) & set(raw_ext) == set(), "merge order would start losing records"
    assert len(set(raw_base) | set(raw_ext)) == EXPECTED_RECORD_COUNT == 140


def test_store_key_set_equals_the_union_of_the_two_permitted_files(
    store: RecommendationStore, raw_base: dict[str, Any], raw_ext: dict[str, Any]
) -> None:
    """The core of Property 12: nothing missing, nothing extra."""
    union = set(raw_base) | set(raw_ext)

    assert set(store.keys()) == union
    assert len(store) == len(store.keys()) == EXPECTED_RECORD_COUNT
    assert len(set(store.keys())) == len(store.keys()), "duplicate keys in merge order"


def test_store_keys_are_base_order_then_extension_order(
    store: RecommendationStore, raw_base: dict[str, Any], raw_ext: dict[str, Any]
) -> None:
    assert store.keys() == list(raw_base) + list(raw_ext)


def test_store_sources_are_exactly_the_two_settings_paths(
    store: RecommendationStore, app_settings: Settings
) -> None:
    """The builder opened two files, and they are the two Requirement 7.1 names."""
    assert store.sources == (
        app_settings.disease_info_path,
        app_settings.disease_info_ext_path,
    )
    assert [path.name for path in store.sources] == [
        "disease_info.json",
        "disease_info_ext.json",
    ]
    for name in EXCLUDED_FILENAMES:
        assert name not in {path.name for path in store.sources}


def test_no_key_unique_to_the_backup_file_reaches_the_store(
    store: RecommendationStore, app_settings: Settings
) -> None:
    """Requirement 7.2, at the only point where the backup file is distinguishable."""
    backup_path = app_settings.data_dir / "disease_info.backup42.json"
    assert backup_path.is_file(), "the excluded file is present, so excluding it is a choice"

    backup_keys = set(json.loads(backup_path.read_text(encoding="utf-8")))
    backup_only = backup_keys - set(store.keys())

    assert BACKUP_ONLY_KEYS.isdisjoint(set(store.keys()))
    assert backup_only == BACKUP_ONLY_KEYS, (
        "the set of backup-only keys moved; re-check which keys are distinguishable"
    )


def test_the_alternate_names_file_is_present_and_indistinguishable_by_content(
    store: RecommendationStore, app_settings: Settings, raw_base: dict[str, Any]
) -> None:
    """``names (2).json`` adds no key of its own, so key equality already covers it."""
    names_path = app_settings.data_dir / "names (2).json"
    assert names_path.is_file()

    entries = json.loads(names_path.read_text(encoding="utf-8"))
    assert isinstance(entries, list)
    assert set(map(str, entries)) <= set(raw_base), (
        "names (2).json now holds a label no permitted file has; assert its absence directly"
    )
    assert names_path not in store.sources


def test_no_store_record_is_a_placeholder(store: RecommendationStore) -> None:
    """Every value came from a data file; the resolver's fallback is not in the store."""
    assert not any(record.is_placeholder for record in store.values())


@given(index=st.integers(min_value=0, max_value=EXPECTED_RECORD_COUNT - 1))
@hypothesis_settings(max_examples=140, deadline=None)
def test_every_record_retains_all_seventeen_source_values(
    index: int, store: RecommendationStore, raw_merged: dict[str, Any]
) -> None:
    """For any record in the store, all 17 fields equal the source file's values.

    Indexed rather than ``sampled_from`` so the module-scoped store fixture is reused
    across examples instead of being rebuilt.

    **Validates: Requirements 7.1, 7.2**
    """
    key = store.keys()[index]
    record = store.records[key]
    source = raw_merged[key]

    assert set(record.data_fields()) == set(REQUIREMENT_FIELDS)
    for name in REQUIREMENT_FIELDS:
        assert getattr(record, name) == expected_field_value(name, source.get(name)), (
            f"{key}.{name} does not match its source value"
        )


_KEY_ALPHABET = string.ascii_letters + string.digits + "_ ()"
_key_strategy = st.text(alphabet=_KEY_ALPHABET, min_size=1, max_size=12)


@given(
    base_keys=st.lists(_key_strategy, max_size=6, unique=True),
    ext_keys=st.lists(_key_strategy, max_size=6, unique=True),
)
@hypothesis_settings(
    max_examples=40,
    deadline=None,
    suppress_health_check=[HealthCheck.too_slow],
)
def test_any_build_key_set_equals_the_union_of_its_two_files(
    base_keys: list[str], ext_keys: list[str]
) -> None:
    """*For any* build: keys == union, base wins collisions, decoy files contribute nothing.

    Poisoned files named exactly like the two excluded ones sit in the same directory. The
    builder takes its two filenames from settings, so they must stay unreachable.

    **Validates: Requirements 7.1, 7.2**
    """
    with tempfile.TemporaryDirectory() as raw_dir:
        data_dir = Path(raw_dir)
        base = {key: synthetic_record(key, "base") for key in base_keys}
        extension = {key: synthetic_record(key, "ext") for key in ext_keys}
        write_json(data_dir / "base.json", base)
        write_json(data_dir / "ext.json", extension)

        # Decoys: same directory, excluded names, keys that exist nowhere else.
        write_json(
            data_dir / EXCLUDED_FILENAMES[0],
            {"POISON_backup42": synthetic_record("POISON_backup42", "backup42")},
        )
        write_json(data_dir / EXCLUDED_FILENAMES[1], ["POISON_names2"])

        built = build_recommendation_store(
            Settings(
                data_dir=data_dir,
                disease_info_name="base.json",
                disease_info_ext_name="ext.json",
            )
        )

    union = set(base_keys) | set(ext_keys)
    assert set(built.keys()) == union
    assert len(built) == len(union)
    assert built.metadata.record_count == len(union)
    assert "POISON_backup42" not in built
    assert "POISON_names2" not in built

    for key in union:
        # disease_info.json is loaded first and wins, being the canonical base.
        assert built.records[key].crop == ("base" if key in base else "ext")


# --- Property 12, part 2: 17 fields with their declared types -------------


def test_recommendation_fields_is_the_requirement_list_in_order() -> None:
    assert RECOMMENDATION_FIELDS == REQUIREMENT_FIELDS
    assert len(RECOMMENDATION_FIELDS) == 17
    assert "is_placeholder" not in RECOMMENDATION_FIELDS
    assert set(Recommendation.model_fields) == set(REQUIREMENT_FIELDS) | {"is_placeholder"}
    # Every field is classified exactly once, so the type table below is exhaustive.
    classified = set(STRING_FIELDS) | set(TEXT_LIST_FIELDS) | set(ITEM_LIST_FIELDS)
    assert classified | {"is_healthy"} == set(REQUIREMENT_FIELDS)
    assert len(STRING_FIELDS) + len(TEXT_LIST_FIELDS) + len(ITEM_LIST_FIELDS) == 16


def test_all_140_records_carry_all_17_fields_with_their_declared_types(
    store: RecommendationStore, raw_merged: dict[str, Any]
) -> None:
    assert len(store) == 140
    for key, record in store.items():
        fields = record.data_fields()
        assert list(fields) == list(REQUIREMENT_FIELDS), key

        # Exhaustive counterpart to the sampled property above.
        source = raw_merged[key]
        for name in REQUIREMENT_FIELDS:
            assert fields[name] == expected_field_value(name, source.get(name)), f"{key}.{name}"

        assert isinstance(record.is_healthy, bool), key
        for name in STRING_FIELDS:
            assert isinstance(fields[name], str), f"{key}.{name}"
        for name in TEXT_LIST_FIELDS:
            value = fields[name]
            assert isinstance(value, list), f"{key}.{name}"
            assert all(isinstance(item, str) for item in value), f"{key}.{name}"
        for name in ITEM_LIST_FIELDS:
            value = fields[name]
            assert isinstance(value, list), f"{key}.{name}"
            for item in value:
                assert isinstance(item, dict), f"{key}.{name}"
                assert all(isinstance(item_key, str) for item_key in item), f"{key}.{name}"
                assert item.get("name"), f"{key}.{name} entry without a name"


def test_the_seventeen_keys_are_present_in_every_source_record(
    raw_merged: dict[str, Any],
) -> None:
    """No field is defaulted in: the data itself carries all 17 keys in all 140 entries."""
    for key, entry in raw_merged.items():
        assert set(REQUIREMENT_FIELDS) <= set(entry), key


def test_measured_emptiness_profile_is_unchanged(store: RecommendationStore) -> None:
    """Emptiness is data, not damage -- these counts pin what the renderer must expect."""
    counts = {
        name: sum(1 for record in store.values() if getattr(record, name))
        for name in MEASURED_NON_EMPTY
    }
    assert counts == MEASURED_NON_EMPTY


def test_metadata_is_derived_from_the_merged_records(store: RecommendationStore) -> None:
    metadata = store.metadata
    assert {
        "crop_count": metadata.crop_count,
        "class_count": metadata.class_count,
        "healthy_class_count": metadata.healthy_class_count,
        "healthy_record_count": metadata.healthy_record_count,
        "record_count": metadata.record_count,
    } == MEASURED_METADATA
    assert metadata.record_count == len(store)
    assert len(metadata.crops) == metadata.crop_count
    assert metadata.crops == sorted(metadata.crops, key=str.casefold)
    assert set(metadata.crops) <= {record.crop for record in store.values()}


def test_loading_one_file_alone_yields_its_own_records(app_settings: Settings) -> None:
    """``load_disease_info`` is per-file, so the merge is the only place keys combine."""
    base = load_disease_info(app_settings.disease_info_path, what="disease_info")
    extension = load_disease_info(app_settings.disease_info_ext_path, what="disease_info_ext")

    assert len(base) == BASE_RECORD_COUNT
    assert len(extension) == EXT_RECORD_COUNT
    assert all(isinstance(record, Recommendation) for record in base.values())
    assert BACKUP_ONLY_KEYS.isdisjoint(set(base) | set(extension))


# --- Property 12, part 3: the collapse never drops a non-duplicate list ---


def test_the_collapse_fires_on_every_current_record(store: RecommendationStore) -> None:
    """Measured: ``prevention == preventive_measures`` in all 140 records."""
    collapsed = [key for key in store.keys() if store.view(key).prevention_collapsed]

    assert len(collapsed) == 140
    for key in collapsed:
        view = store.view(key)
        assert view.prevention == []
        assert view.preventive_measures == store.records[key].preventive_measures
        assert view.preventive_measures, "collapsing an empty list would hide nothing"
        assert "prevention" not in view.visible_fields()
        assert view.visible_fields()["preventive_measures"] == view.preventive_measures


def test_the_collapse_never_drops_a_non_duplicate_list() -> None:
    """A synthetic record, because no real record has the two lists differing."""
    record = Recommendation(
        crop="Mango",
        disease="Anthracnose",
        preventive_measures=["Prune dense canopy", "Avoid overhead irrigation"],
        prevention=["Remove fallen fruit"],
    )
    view = record.view(source_key="Mango___Anthracnose")

    assert view.prevention_collapsed is False
    assert view.prevention == ["Remove fallen fruit"]
    assert view.preventive_measures == [
        "Prune dense canopy",
        "Avoid overhead irrigation",
    ]
    assert view.visible_fields()["prevention"] == ["Remove fallen fruit"]
    assert view.fields()["prevention"] == ["Remove fallen fruit"]


def test_a_shared_prefix_is_not_a_duplicate() -> None:
    """Equality is element-for-element: a superset still carries distinct advice."""
    shared = ["Rotate crops"]
    record = Recommendation(
        preventive_measures=shared,
        prevention=[*shared, "Solarise the soil"],
    )
    view = record.view()

    assert view.prevention_collapsed is False
    assert view.prevention == ["Rotate crops", "Solarise the soil"]


def test_both_lists_empty_is_not_a_collapse() -> None:
    view = Recommendation().view()

    assert view.prevention_collapsed is False
    assert view.prevention == []
    assert view.preventive_measures == []
    assert "prevention" not in view.visible_fields()
    assert "preventive_measures" not in view.visible_fields()


_advice = st.lists(
    st.text(alphabet=string.ascii_letters + " ", min_size=1, max_size=8).map(str.strip),
    max_size=4,
).map(lambda items: [item for item in items if item])


@given(preventive_measures=_advice, prevention=_advice)
@hypothesis_settings(max_examples=100, deadline=None)
def test_the_collapse_hides_only_an_exact_duplicate(
    preventive_measures: list[str], prevention: list[str]
) -> None:
    """*For any* pair of lists, the collapse drops ``prevention`` only when it is a copy.

    **Validates: Requirements 7.1, 7.2**
    """
    record = Recommendation(
        preventive_measures=preventive_measures,
        prevention=prevention,
    )
    view = record.view()

    duplicate = bool(prevention) and prevention == preventive_measures
    assert view.prevention_collapsed is duplicate
    assert view.prevention == ([] if duplicate else prevention)
    # The kept side is never touched, and nothing distinct is ever lost.
    assert view.preventive_measures == preventive_measures
    assert set(prevention) <= set(view.prevention) | set(view.preventive_measures)
    assert ("prevention" in view.visible_fields()) is bool(view.prevention)
