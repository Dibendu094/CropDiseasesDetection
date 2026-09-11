"""The two-model confidence cascade (Requirement 5, with 10.4/10.5 folded in).

One image goes in, one diagnosis comes out. The primary ViT answers first; the
EfficientNet backup is consulted only when the ViT is not confident enough, and
the more confident of the two wins.

The rules this module exists to hold still on:

* **The backup is not touched on the confident path.** When the primary's top-1
  reaches ``settings.confidence_threshold``, :func:`predict` returns before it so
  much as looks the backup up in the registry — no lazy load of a second
  checkpoint, no second preprocess, no second forward pass (Req 5.2). This is
  observable: a counting test double records zero calls.
* **Ties go to the primary.** The comparison is ``r1.top.confidence >=
  r2.top.confidence``, so two models that agree to the last bit produce the ViT's
  answer every time. Determinism matters more here than any notion of fairness
  between the two heads (Req 5.3).
* **Candidates come from the winner alone, never merged.** Requirement 5.7
  forbids a side-by-side comparison view, so :func:`finish` copies the winning
  :class:`ModelResult`'s three candidates through untouched (Req 5.5).
* **``is_uncertain`` is computed once, from the winner.** A 0.62 primary against a
  0.55 backup yields the 0.62 answer *flagged* uncertain, not a suppressed result
  (Req 5.6).
* **Availability degrades, it does not crash.** Primary down and backup up is a
  backup-only run (Req 10.4); both down is
  :class:`~app.errors.ServiceUnavailableError`, which the handler renders as
  ``503 MODELS_UNAVAILABLE`` (Req 10.5).

The threshold is read from :class:`app.config.Settings` on every call — from the
registry's own settings when the caller does not pass any — so an operator who
sets ``CONFIDENCE_THRESHOLD=0.85`` changes the cascade and nothing else. The
number 0.70 appears nowhere in this file.

**The optional crop hint lives here, not in the router.** When the caller supplies
``crop`` plus the startup-built :class:`~app.services.crop_index.CropIndex`, each
model's softmax is restricted to that crop's class indices and renormalised over
them (``allowed_indices`` on :func:`run_model`), so a confidence is a probability
*within* the crop. None of the cascade rules move: the threshold gate, the
"backup only when unconfident" rule and the tie-to-the-primary rule all apply to
the masked distribution. A hint that cannot be honoured — unknown crop, no index,
or a crop with no class in one model's vocabulary — is logged at WARNING and that
model runs unconstrained, so a bad hint costs nothing but the constraint. With no
crop passed, every path below behaves exactly as it did before the parameter
existed.

Labels stay raw. A :class:`Prediction` carries the vocabulary strings the winning
model emitted (``Apple___Apple_scab``, ``Apple__scab``); mapping them to store
records and human-readable names is
:class:`~app.services.label_resolver.LabelResolver`'s job, done in the router
where the response payload is assembled. :func:`describe_candidates` is the one
convenience offered for that step and it takes the resolver as an argument rather
than reaching for a global.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import TYPE_CHECKING, Protocol

import torch
from PIL import Image

from ..config import Settings, get_settings
from ..errors import ServiceUnavailableError
from ..logging_config import get_logger
from .model_registry import EFFNET_MODEL_ID, VIT_MODEL_ID, LoadedModel
from .preprocess import to_tensor

if TYPE_CHECKING:  # pragma: no cover - typing only, avoids an import cycle at runtime
    from .crop_index import CropFilter, CropIndex
    from .label_resolver import LabelResolver

__all__ = [
    "TOP_K",
    "Candidate",
    "ModelResult",
    "Prediction",
    "run_model",
    "predict",
    "finish",
    "describe_candidates",
]

log = get_logger(__name__)

TOP_K = 3
"""How many candidates a result carries (Req 5.5). Clamped down for a tiny vocabulary."""


# --- results ---------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class Candidate:
    """One class and its probability.

    ``label`` is the raw vocabulary string of the model that produced it, and
    ``confidence`` is a softmax probability in ``[0, 1]``.
    """

    label: str
    confidence: float


@dataclass(frozen=True, slots=True)
class ModelResult:
    """What one model said about one image.

    ``candidates`` holds up to :data:`TOP_K` entries in descending confidence and
    ``top`` is ``candidates[0]``. Fewer than three appear only when the model's
    vocabulary is smaller than three, which no real checkpoint here is.
    """

    model_id: str
    top: Candidate
    candidates: list[Candidate]


@dataclass(frozen=True, slots=True)
class Prediction:
    """The cascade's verdict, ready for the router to dress up.

    Attributes:
        model_used: the id of the model whose answer this is (Req 5.4).
        label: the winner's top-1 raw label.
        confidence: the winner's top-1 probability.
        candidates: the winner's top-3, winner only, never a merge (Req 5.5, 5.7).
        is_uncertain: ``confidence < threshold``, decided once from the winner
            (Req 5.6).
        models_run: which models actually performed a forward pass, in the order
            they ran. One entry on the confident path, two when the backup was
            consulted.
        crop_filter: the canonical crop name the winning model's distribution was
            masked to, or ``None`` when it ran over its whole vocabulary. This is
            what ``meta.crop_filter`` reports, so it is the crop that was
            *applied*, never merely the one that was asked for.
    """

    model_used: str
    label: str
    confidence: float
    candidates: list[Candidate]
    is_uncertain: bool
    models_run: list[str]
    crop_filter: str | None = None


# --- one forward pass ------------------------------------------------------


def run_model(
    loaded_model: LoadedModel,
    image: Image.Image,
    allowed_indices: Sequence[int] | None = None,
) -> ModelResult:
    """Preprocess, run, and read off the top-``k`` classes for one model.

    Preprocessing uses the model's *own* spec, so the ViT sees 384 px with
    symmetric normalisation and the EfficientNet sees 300 px with ImageNet
    normalisation through the identical code path (Req 5.8). Indices are mapped
    through that model's own ``labels`` list — the two vocabularies are ordered
    differently and must never be crossed.

    ``allowed_indices`` is the crop hint's whole mechanism. When it is given, the
    softmax is *restricted* to those class indices and renormalised over them, so
    the reported confidence is a probability within the crop rather than a
    fraction of all 91 classes, and ``topk`` can only ever name a class from the
    crop -- there is no "kept but zeroed" class to leak in when the crop holds
    fewer than :data:`TOP_K` classes. When it is ``None`` (or empty, or entirely
    out of range) the model runs over its whole vocabulary exactly as before.

    Args:
        loaded_model: a model with ``loaded=True``; its ``module`` is called.
        image: the once-decoded ``PIL.Image`` for this request.
        allowed_indices: class indices to restrict the distribution to, or
            ``None`` for unconstrained inference.

    Returns:
        A :class:`ModelResult` whose candidates descend by confidence.

    Raises:
        ServiceUnavailableError: ``loaded_model`` has no usable module. Callers in
            this module check ``loaded`` first, so this only fires if a caller
            skips that check.
    """
    module = loaded_model.module
    if module is None or not loaded_model.loaded:
        log.error("run_model called on unavailable model %s", loaded_model.model_id)
        raise ServiceUnavailableError

    # inference_mode is the whole of "no autograd": no graph, no version
    # counters, and it covers the preprocess tensor as well as the forward pass.
    with torch.inference_mode():
        tensor = to_tensor(image, loaded_model.spec)
        logits = module(tensor)
        probs = torch.softmax(logits, dim=1)[0]

        kept = _kept_indices(allowed_indices, int(probs.numel()), loaded_model.model_id)
        if kept:
            # index_select gives a distribution over the crop's classes only;
            # ``selector`` maps a position in it back to a real class index.
            selector = torch.as_tensor(kept, dtype=torch.long, device=probs.device)
            distribution = probs.index_select(0, selector)
            total = float(distribution.sum())
            if total > 0.0:
                distribution = distribution / total
            else:  # pragma: no cover - a crop with zero mass under float32
                log.warning(
                    "%s: the %d crop-constrained class(es) carry no probability mass; "
                    "confidences are left unnormalised",
                    loaded_model.model_id,
                    len(kept),
                )
        else:
            selector = None
            distribution = probs

        # A 91-class head against a 91-label map is the normal case, but a stub
        # or a mismatched checkpoint could hand back fewer logits than labels or
        # fewer labels than three. topk raises on k > n, so clamp.
        k = min(TOP_K, int(distribution.numel()))
        if k <= 0:  # pragma: no cover - an empty classifier head cannot predict
            log.error("%s produced no logits", loaded_model.model_id)
            raise ServiceUnavailableError
        confidences, positions = torch.topk(distribution, k=k)
        indices = positions if selector is None else selector.index_select(0, positions)

    labels = loaded_model.labels
    candidates = [
        Candidate(label=_label_at(labels, int(index)), confidence=float(confidence))
        for confidence, index in zip(confidences.tolist(), indices.tolist())
    ]
    return ModelResult(
        model_id=loaded_model.model_id, top=candidates[0], candidates=candidates
    )


def _kept_indices(
    allowed_indices: Sequence[int] | None,
    size: int,
    model_id: str,
) -> list[int]:
    """The usable subset of ``allowed_indices``: ascending, deduplicated, in range.

    Returns ``[]`` for "no mask", which is what ``None``, an empty sequence and a
    set of indices that all fall outside this head's width all mean. An empty
    result therefore degrades to unconstrained inference rather than to an
    impossible ``topk`` -- a bad hint must never cost the user their diagnosis.
    """
    if allowed_indices is None:
        return []

    kept = sorted({int(index) for index in allowed_indices if 0 <= int(index) < size})
    if not kept:
        log.warning(
            "%s: none of the %d requested class index/indices are within this model's "
            "%d output(s); running unconstrained",
            model_id,
            len(list(allowed_indices)),
            size,
        )
        return []

    dropped = len({int(index) for index in allowed_indices}) - len(kept)
    if dropped:
        log.warning(
            "%s: %d requested class index/indices fall outside this model's %d output(s) "
            "and were ignored",
            model_id,
            dropped,
            size,
        )
    return kept


def _label_at(labels: Sequence[str], index: int) -> str:
    """The vocabulary entry at ``index``, or a synthetic name if it is absent.

    A class id with no label means the checkpoint's head is wider than the label
    map. That is logged loudly at load time; here it must not raise, because
    returning ``class_57`` still lets the resolver fall through to the
    placeholder record and the user still gets a response.
    """
    if 0 <= index < len(labels):
        return labels[index]
    log.warning("class index %d has no label (vocabulary holds %d)", index, len(labels))
    return f"class_{index}"


# --- the cascade -----------------------------------------------------------


class _RegistryLike(Protocol):
    """The one method :func:`predict` needs, so tests can pass a stub registry."""

    def get(self, model_id: str) -> LoadedModel: ...


def predict(
    image: Image.Image,
    registry: _RegistryLike,
    settings: Settings | None = None,
    *,
    crop: str | None = None,
    crop_index: CropIndex | None = None,
) -> Prediction:
    """Run the cascade for one image and return the winning diagnosis.

    The flow, in the order Requirement 5 states it:

    1. Primary loaded, top-1 at or above the threshold → return it, backup never
       touched (Req 5.1, 5.2).
    2. Primary loaded, top-1 below the threshold, backup loaded → run the backup
       and keep the higher top-1, ties to the primary (Req 5.3).
    3. Primary loaded, top-1 below the threshold, backup unavailable → return the
       primary's answer, flagged uncertain.
    4. Primary unavailable, backup loaded → backup only (Req 10.4).
    5. Neither loaded → :class:`ServiceUnavailableError` (Req 10.5).

    Args:
        image: the decoded upload. Decoded once by the caller and reused for both
            models, so a cascade costs two preprocesses and no second decode.
        registry: the process-wide :class:`~app.services.model_registry.ModelRegistry`.
        settings: overrides the threshold source; defaults to the registry's own
            settings, then to :func:`app.config.get_settings`.
        crop: optional crop hint from the request. Blank, whitespace and ``None``
            mean "no hint" and leave every step below byte-identical to the
            unconstrained path.
        crop_index: the startup-built :class:`~app.services.crop_index.CropIndex`.
            Required for ``crop`` to have any effect; absent, the hint is logged
            and ignored.

    Returns:
        A :class:`Prediction` carrying raw labels.

    Raises:
        ServiceUnavailableError: no model can serve the request (Req 10.5).

    The crop hint changes *what each model is allowed to say*, never the cascade
    rules: the threshold comparison, the "backup only when unconfident" gate and
    the tie-to-the-primary rule all apply to the masked distribution unchanged. A
    hint that cannot be honoured (unknown crop, or a crop with no class in one
    model's vocabulary) is logged at WARNING and that model runs unconstrained,
    because a bad hint must not cost the user their diagnosis.
    """
    threshold = _threshold(settings, registry)
    crop_filter = _crop_filter(crop, crop_index)
    masked: set[str] = set()
    primary = _lookup(registry, VIT_MODEL_ID)

    if primary is not None and primary.loaded:
        # Req 5.1: the ViT answers first.
        result = run_model(primary, image, _allowed_for(crop_filter, primary.model_id, masked))

        # Req 5.2. Returning here is the point: no registry.get for the backup,
        # so a lazily loaded backup is not even paged in, let alone run.
        if result.top.confidence >= threshold:
            log.info(
                "cascade: %s top-1 %.4f >= %.2f, backup not consulted",
                result.model_id,
                result.top.confidence,
                threshold,
            )
            return finish(
                result,
                [primary.model_id],
                threshold=threshold,
                crop_filter=_applied_crop(crop_filter, masked, result.model_id),
            )

        backup = _lookup(registry, EFFNET_MODEL_ID)
        if backup is None or not backup.loaded:
            log.info(
                "cascade: %s top-1 %.4f < %.2f but the backup is unavailable; "
                "returning the primary result",
                result.model_id,
                result.top.confidence,
                threshold,
            )
            return finish(
                result,
                [primary.model_id],
                threshold=threshold,
                crop_filter=_applied_crop(crop_filter, masked, result.model_id),
            )

        # Req 5.3
        backup_result = run_model(
            backup, image, _allowed_for(crop_filter, backup.model_id, masked)
        )
        # >= keeps a tie with the primary, which makes the outcome deterministic.
        winner = (
            result
            if result.top.confidence >= backup_result.top.confidence
            else backup_result
        )
        log.info(
            "cascade: %s %.4f vs %s %.4f (threshold %.2f) -> %s",
            result.model_id,
            result.top.confidence,
            backup_result.model_id,
            backup_result.top.confidence,
            threshold,
            winner.model_id,
        )
        return finish(
            winner,
            [primary.model_id, backup.model_id],
            threshold=threshold,
            crop_filter=_applied_crop(crop_filter, masked, winner.model_id),
        )

    # Primary unavailable from here on.
    backup = _lookup(registry, EFFNET_MODEL_ID)
    if backup is None or not backup.loaded:
        log.error("cascade: neither model is loaded; refusing the request")
        raise ServiceUnavailableError  # Req 10.5 -> 503 MODELS_UNAVAILABLE

    log.warning(
        "cascade: primary unavailable (%s), serving from %s alone",
        "absent" if primary is None else (primary.error or "not loaded"),
        backup.model_id,
    )
    # Req 10.4
    result = run_model(backup, image, _allowed_for(crop_filter, backup.model_id, masked))
    return finish(
        result,
        [backup.model_id],
        threshold=threshold,
        crop_filter=_applied_crop(crop_filter, masked, result.model_id),
    )


def finish(
    result: ModelResult,
    models_run: list[str],
    *,
    threshold: float | None = None,
    crop_filter: str | None = None,
) -> Prediction:
    """Turn the winning :class:`ModelResult` into a :class:`Prediction`.

    The winner's identity, top-1 and candidate list pass straight through — the
    candidates are the winning model's alone, never a merge of both models
    (Req 5.5, 5.7) — and uncertainty is decided here, once, from that same
    top-1 (Req 5.6).

    Args:
        result: the model result that won the cascade.
        models_run: ids of the models that actually ran a forward pass, in order.
        threshold: the confidence threshold; read from settings when omitted.
        crop_filter: canonical crop name the winner's distribution was masked to,
            or ``None`` for an unconstrained run.
    """
    limit = get_settings().confidence_threshold if threshold is None else threshold
    return Prediction(
        model_used=result.model_id,  # Req 5.4
        label=result.top.label,
        confidence=result.top.confidence,
        candidates=list(result.candidates),  # Req 5.5, winning model only
        is_uncertain=result.top.confidence < limit,  # Req 5.6
        models_run=list(models_run),
        crop_filter=crop_filter,
    )


# --- the crop hint ---------------------------------------------------------


def _crop_filter(crop: str | None, crop_index: CropIndex | None) -> CropFilter | None:
    """Resolve the request's crop hint to a :class:`CropFilter`, or ``None``.

    ``None`` means "run unconstrained", and it is returned for every way a hint
    can fail to apply: absent, blank, no index available, or a crop the index has
    never heard of. Only the last two are logged, because absent and blank are the
    ordinary case, not a problem.
    """
    if crop is None:
        return None
    text = crop.strip() if isinstance(crop, str) else str(crop).strip()
    if not text:
        return None

    if crop_index is None:
        log.warning("crop hint %r supplied but no crop index is available; ignoring it", text)
        return None

    matched = crop_index.resolve(text)
    if matched is None:
        log.warning(
            "unknown crop hint %r; running unconstrained inference instead", text
        )
        return None

    log.info(
        "crop hint %r resolved to %r (%s)",
        text,
        matched.crop,
        " ".join(f"{mid}={count}" for mid, count in matched.class_counts().items()),
    )
    return matched


def _allowed_for(
    crop_filter: CropFilter | None,
    model_id: str,
    masked: set[str],
) -> tuple[int, ...] | None:
    """The class indices ``model_id`` may answer with, or ``None`` for all of them.

    Records ``model_id`` in ``masked`` when a mask is really being applied, which
    is what lets :func:`_applied_crop` report the crop only for a model that was
    actually constrained.
    """
    if crop_filter is None:
        return None

    indices = crop_filter.for_model(model_id)
    if not indices:
        log.warning(
            "crop %r has no class in %s's vocabulary; running it unconstrained",
            crop_filter.crop,
            model_id,
        )
        return None

    masked.add(model_id)
    return indices


def _applied_crop(
    crop_filter: CropFilter | None,
    masked: set[str],
    model_id: str,
) -> str | None:
    """The canonical crop name to report for ``model_id``'s result.

    ``None`` unless that specific model ran masked, so ``meta.crop_filter``
    describes the distribution the answer actually came from rather than the
    request's intent.
    """
    if crop_filter is None or model_id not in masked:
        return None
    return crop_filter.crop


def _threshold(settings: Settings | None, registry: _RegistryLike) -> float:
    """The confidence threshold in force, never a literal (Req 5.2).

    Preference: the explicit argument, then the registry's own settings (which is
    what the app is actually configured with), then the cached global settings.
    """
    if settings is not None:
        return float(settings.confidence_threshold)
    registry_settings = getattr(registry, "settings", None)
    if isinstance(registry_settings, Settings):
        return float(registry_settings.confidence_threshold)
    return float(get_settings().confidence_threshold)


def _lookup(registry: _RegistryLike, model_id: str) -> LoadedModel | None:
    """Fetch a model from the registry, or ``None`` if it does not know that id.

    A registry built without one of the two specs (a stub in a test, a future
    single-model deployment) should degrade down the same availability branches
    as a broken checkpoint rather than raising ``KeyError`` mid-request.
    """
    try:
        return registry.get(model_id)
    except KeyError:
        log.warning("registry holds no model with id %r", model_id)
        return None


# --- for the router --------------------------------------------------------


def describe_candidates(
    candidates: Sequence[Candidate],
    resolver: LabelResolver,
    model_id: str | None = None,
) -> list[tuple[str, str, float]]:
    """Attach a display name to each candidate: ``(label, display_name, confidence)``.

    Offered so the router can build ``CandidateOut`` rows without repeating the
    resolver call, while label resolution itself stays entirely outside the
    cascade — a :class:`Prediction` never carries a resolved name.

    Args:
        candidates: usually ``prediction.candidates``, order preserved.
        resolver: the process-wide resolver.
        model_id: the model that produced these labels, normally
            ``prediction.model_used``. It selects the ViT label map's curated
            ``display_name`` when the ViT won.
    """
    return [
        (
            candidate.label,
            resolver.resolve_with_display_name(candidate.label, model_id)[1],
            candidate.confidence,
        )
        for candidate in candidates
    ]
