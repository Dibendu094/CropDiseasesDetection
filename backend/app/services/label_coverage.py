"""The startup coverage assertion: prove all 182 labels reach a real Recommendation.

Requirement 7.3 and 7.4 demand that every one of the 91 EfficientNet labels and every one
of the 91 ViT labels resolves to exactly one Recommendation. Requirement 7.7 demands the
backend *verify* that at startup and *log the identity* of anything that fails. Nothing in
the request path can do this: a single prediction only touches one label, and the
placeholder record (Req 7.8) makes a miss invisible at runtime. So the check runs once at
boot, over both vocabularies, and its result is carried forward instead of recomputed.

What "assertion" means here: the check logs loudly and reports, it does not abort. A label
that cannot be resolved degrades exactly one class to the placeholder, and refusing to boot
over it would take the other 181 classes down with it (the same trade the model registry
makes for a missing checkpoint, Req 10.3). The unresolved list therefore travels to
``GET /api/health`` as ``recommendation_store.unresolved``, where a deviation is visible
without reading logs.

Measured steady state, over the real data files:

| Label map        | exact | normalized | pair | alias | unresolved |
|------------------|-------|------------|------|-------|------------|
| EfficientNet (91)|    91 |          0 |    0 |     0 |          0 |
| ViT (91)         |    49 |         23 |    8 |    11 |          0 |

``labels_checked`` is 182 -- the two maps are counted separately even where they name the
same class, because a label is resolved *as the model that emitted it*: the ViT's
``Apple__scab`` and EfficientNet's ``Apple___Apple_scab`` take different ladder stages and
each has to be proven on its own.

The result is a frozen :class:`CoverageReport`. ``app/main.py`` builds it during startup and
logs it; ``app/routers/meta.py`` reads the same object for the health payload, so the health
endpoint never re-resolves 182 labels per request.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from functools import lru_cache
from typing import Any

from ..logging_config import (
    get_logger,
    log_stage_histogram,
    log_unresolved_labels,
)
from .label_maps import LabelMaps, load_label_maps
from .label_resolver import (
    EFFNET_MODEL_ID,
    VIT_MODEL_ID,
    LabelResolver,
    empty_histogram,
    get_label_resolver,
    histogram_of,
    nonzero_stages,
)

__all__ = [
    "EFFNET_MAP_NAME",
    "VIT_MAP_NAME",
    "MapCoverage",
    "CoverageReport",
    "check_label_coverage",
    "get_label_coverage",
    "reset_label_coverage",
]

log = get_logger(__name__)

EFFNET_MAP_NAME = "effnet"
VIT_MAP_NAME = "vit"
"""Group names for the nested histogram, and the ``source`` on an unresolved-label line."""


@dataclass(frozen=True, slots=True)
class MapCoverage:
    """Coverage of one label map: how many labels, by which stages, and what missed.

    Attributes:
        map_name: ``"effnet"`` or ``"vit"`` -- the histogram group name.
        model_id: the model whose vocabulary this is, which is also what decides where
            stage 3's ``(crop, disease)`` hint comes from.
        labels_checked: number of labels resolved (91 for either map today).
        histogram: stage counts with every stage present, in resolver stage order.
        unresolved: labels that reached the placeholder, in label-map order.
    """

    map_name: str
    model_id: str
    labels_checked: int
    histogram: dict[str, int]
    unresolved: tuple[str, ...]

    @property
    def complete(self) -> bool:
        """True when every label in this map resolved to a real record."""
        return not self.unresolved

    @property
    def resolved(self) -> int:
        """Labels that resolved to a real record."""
        return self.labels_checked - len(self.unresolved)

    def stages(self) -> dict[str, int]:
        """The histogram without its zero entries, for compact assertions and messages."""
        return nonzero_stages(self.histogram)


@dataclass(frozen=True, slots=True)
class CoverageReport:
    """The whole coverage assertion, in the shape both consumers need.

    ``main.py`` wants the histograms and the offender list to log; the health route wants
    ``records`` / ``labels_checked`` / ``unresolved``. Both come off this one object.
    """

    maps: tuple[MapCoverage, ...]
    record_count: int

    @property
    def labels_checked(self) -> int:
        """182 in the steady state: 91 EfficientNet labels plus 91 ViT labels."""
        return sum(coverage.labels_checked for coverage in self.maps)

    @property
    def unresolved(self) -> tuple[str, ...]:
        """Every unresolved label from every map, EfficientNet first."""
        return tuple(label for coverage in self.maps for label in coverage.unresolved)

    @property
    def unresolved_with_source(self) -> tuple[tuple[str, str], ...]:
        """``(label, map_name)`` pairs -- what ``log_unresolved_labels`` names offenders with."""
        return tuple(
            (label, coverage.map_name)
            for coverage in self.maps
            for label in coverage.unresolved
        )

    @property
    def complete(self) -> bool:
        """True when all 182 labels resolved. The expected state; a False here is a defect."""
        return not self.unresolved

    def for_map(self, map_name: str) -> MapCoverage:
        """The :class:`MapCoverage` for ``"effnet"`` / ``"vit"``.

        Raises:
            KeyError: no map by that name was checked.
        """
        for coverage in self.maps:
            if coverage.map_name == map_name:
                return coverage
        raise KeyError(f"no coverage recorded for label map {map_name!r}")

    @property
    def effnet(self) -> MapCoverage:
        """Coverage of the EfficientNet vocabulary (Req 7.3)."""
        return self.for_map(EFFNET_MAP_NAME)

    @property
    def vit(self) -> MapCoverage:
        """Coverage of the ViT vocabulary (Req 7.4)."""
        return self.for_map(VIT_MAP_NAME)

    def histograms(self) -> dict[str, dict[str, int]]:
        """Per-map stage counts, ``{"effnet": {...}, "vit": {...}}``.

        This is the nested shape ``logging_config.format_stage_histogram`` renders as
        ``{effnet[exact=91 ...] vit[exact=49 ...]}``.
        """
        return {coverage.map_name: dict(coverage.histogram) for coverage in self.maps}

    def combined_histogram(self) -> dict[str, int]:
        """Stage counts summed across both maps, every stage present."""
        total = empty_histogram()
        for coverage in self.maps:
            for stage, count in coverage.histogram.items():
                total[stage] = total.get(stage, 0) + count
        return total

    def as_health_dict(self) -> dict[str, Any]:
        """The health endpoint's ``recommendation_store`` block (design: ``GET /api/health``).

        ``unresolved`` is a list rather than a tuple because it is serialised straight to
        JSON, and empty in the steady state.
        """
        return {
            "records": self.record_count,
            "labels_checked": self.labels_checked,
            "unresolved": list(self.unresolved),
        }


def check_label_coverage(
    resolver: LabelResolver | None = None,
    label_maps: LabelMaps | None = None,
    *,
    logger: logging.Logger | None = None,
    level: int = logging.INFO,
) -> CoverageReport:
    """Resolve both vocabularies, log the outcome, and return it (Req 7.3, 7.4, 7.7).

    Args:
        resolver: defaults to the process-wide resolver. Startup passes the one it just
            built so the indexes are not constructed twice.
        label_maps: defaults to the resolver's own maps, then to a fresh load. Passing the
            maps that startup already loaded avoids re-reading the two JSON files.
        logger: defaults to this module's logger.
        level: level for the histogram line. Unresolved labels always log at ``ERROR``
            (``log_unresolved_labels``), so an offender is visible at any configured level.

    Returns:
        A :class:`CoverageReport`. Never raises on a coverage failure -- a missing label
        degrades one class, and the report plus the health endpoint are how that surfaces.
    """
    active_log = logger or log
    active_resolver = resolver if resolver is not None else get_label_resolver()
    maps = label_maps or active_resolver.label_maps or load_label_maps()

    coverages = tuple(
        _cover(active_resolver, map_name, model_id, labels)
        for map_name, model_id, labels in (
            (EFFNET_MAP_NAME, EFFNET_MODEL_ID, maps.effnet_labels),
            (VIT_MAP_NAME, VIT_MODEL_ID, maps.vit_labels),
        )
    )
    report = CoverageReport(maps=coverages, record_count=len(active_resolver.store))

    log_stage_histogram(report.histograms(), logger=active_log, level=level)
    log_unresolved_labels(
        report.unresolved_with_source,
        logger=active_log,
        source=f"{report.labels_checked} labels across both label maps",
    )
    return report


def _cover(
    resolver: LabelResolver,
    map_name: str,
    model_id: str,
    labels: list[str],
) -> MapCoverage:
    """Resolve one vocabulary once, and read both the histogram and the misses off it."""
    resolutions = resolver.resolve_labels(labels, model_id)
    return MapCoverage(
        map_name=map_name,
        model_id=model_id,
        labels_checked=len(resolutions),
        histogram=histogram_of(resolutions),
        unresolved=tuple(r.label for r in resolutions if r.is_placeholder),
    )


@lru_cache(maxsize=1)
def get_label_coverage() -> CoverageReport:
    """The process-wide coverage report, computed on first use.

    Startup calls this (rather than :func:`check_label_coverage`) so the boot-time log lines
    and the health payload come from one computation: the cache means the health route reads
    the same object per request without re-resolving 182 labels. Use
    :func:`check_label_coverage` directly when the resolver or the maps are supplied
    explicitly, as tests do.
    """
    return check_label_coverage()


def reset_label_coverage() -> None:
    """Drop the cached report so the next :func:`get_label_coverage` recomputes it."""
    get_label_coverage.cache_clear()
