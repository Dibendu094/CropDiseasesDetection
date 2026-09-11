"""Checkpoint discovery, model construction, and the process-wide model singletons.

Two checkpoints back this application, and they disagree about almost everything
except the size of their classifier head:

* ``vit_b16`` (primary) — ``vit_base_patch16_384`` at 384 px with symmetric
  ``0.5`` normalisation. The checkpoint is self-describing: it carries
  ``model_name``, ``image_size``, ``num_classes``, its weights under
  ``model_state_dict``, and its own ``label_mapping``.
* ``efficientnet_b3`` (backup) — ``efficientnet_b3`` at 300 px with ImageNet
  normalisation. This checkpoint records no training resolution, so 300 comes
  from ``Settings.effnet_input_size`` rather than from the file.

Three behaviours are load-bearing here:

* **A broken checkpoint degrades, it does not abort.** Every failure mode
  (missing file, unreadable file, no recoverable state dict, architecture that
  will not build, weights that will not fit) is logged with the path and turned
  into ``LoadedModel(loaded=False, error=...)``. Startup continues, the health
  endpoint reports the model as unavailable, and the cascade routes around it
  (Req 10.3).
* **Paths are never quoted, because they are never strings.** The checkpoint
  path arrives from :class:`app.config.Settings` as a ``Path`` composed with
  ``/`` and is handed to ``torch.load`` as a ``Path``. The space and parentheses
  in ``vit_b16_epoch_02 (2).pth`` never reach a shell or a format string, which
  is how Requirement 6.2 is satisfied structurally rather than by escaping.
* **One instance per model id, ever.** :meth:`ModelRegistry.get` is guarded by a
  ``threading.Lock`` with a double-checked read, so concurrent first requests
  cannot double-load ~1 GB of ViT weights (Req 6.3). The registry itself is
  constructed once in the lifespan handler and parked on ``app.state.registry``.

A half-loaded model is treated as worse than an unavailable one. ``strict=True``
is the normal path; the ``strict=False`` retry exists only to tolerate *extra*
keys in a checkpoint, and it refuses any model whose classifier head or whose
backbone parameters did not actually arrive. Confident nonsense from a randomly
initialised backbone is harder to diagnose than a 503.
"""

from __future__ import annotations

import pickle
import threading
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import timm
import torch

from ..config import Settings, get_settings
from ..logging_config import get_logger, log_resolved_paths
from .label_maps import LabelMaps, load_label_maps

__all__ = [
    "VIT_MODEL_ID",
    "EFFNET_MODEL_ID",
    "PRIMARY_ROLE",
    "BACKUP_ROLE",
    "IMAGENET_MEAN",
    "IMAGENET_STD",
    "SYMMETRIC_MEAN",
    "SYMMETRIC_STD",
    "STATE_DICT_KEYS",
    "ModelSpec",
    "LoadedModel",
    "ModelRegistry",
    "build_specs",
    "build_registry",
    "resolve_device",
    "verify_label_mapping",
]

log = get_logger(__name__)

VIT_MODEL_ID = "vit_b16"
EFFNET_MODEL_ID = "efficientnet_b3"

PRIMARY_ROLE = "primary"
BACKUP_ROLE = "backup"

SYMMETRIC_MEAN = (0.5, 0.5, 0.5)
SYMMETRIC_STD = (0.5, 0.5, 0.5)
IMAGENET_MEAN = (0.485, 0.456, 0.406)
IMAGENET_STD = (0.229, 0.224, 0.225)

STATE_DICT_KEYS = ("model_state_dict", "state_dict")
"""Checkpoint keys searched, in order, before falling back to the object itself."""

_MODULE_PREFIX = "module."
"""Left behind by ``torch.nn.DataParallel``; stripped so keys match a bare module."""

# torch's safe loader signals "this file needs the full unpickler" differently
# across versions: pickle.UnpicklingError classically, a bare RuntimeError or
# AttributeError in some 2.x releases. All of them are worth one retry with
# weights_only=False, because a torch upgrade must not brick startup. A genuinely
# corrupt file simply fails the retry too and is reported as unreadable.
_UNPICKLING_RETRY_ERRORS = (
    pickle.UnpicklingError,
    AttributeError,
    RuntimeError,
    TypeError,
    EOFError,
)

_ARCHES_TAKING_IMG_SIZE = ("vit", "deit", "beit")
"""timm families whose ``create_model`` accepts ``img_size`` for a resized grid."""

_threads_lock = threading.Lock()
_threads_applied = False


# --- specs -----------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class ModelSpec:
    """Everything needed to build one model and preprocess for it.

    Frozen because preprocessing reads ``input_size``/``mean``/``std`` on every
    request and the values must not drift after startup. A checkpoint override
    (the ViT's embedded ``image_size``, say) produces a *replacement* spec via
    :meth:`with_overrides`, never a mutation.
    """

    id: str
    role: str
    arch: str
    input_size: int
    mean: tuple[float, float, float]
    std: tuple[float, float, float]
    checkpoint: Path

    @property
    def takes_img_size(self) -> bool:
        """Whether ``timm.create_model`` should receive ``img_size`` for this arch."""
        arch = self.arch.lower()
        return any(arch.startswith(family) for family in _ARCHES_TAKING_IMG_SIZE)

    def with_overrides(self, *, arch: str | None = None, input_size: int | None = None) -> ModelSpec:
        """Return a copy carrying checkpoint-supplied ``arch`` / ``input_size``."""
        if arch is None and input_size is None:
            return self
        return ModelSpec(
            id=self.id,
            role=self.role,
            arch=arch or self.arch,
            input_size=input_size or self.input_size,
            mean=self.mean,
            std=self.std,
            checkpoint=self.checkpoint,
        )


@dataclass(slots=True)
class LoadedModel:
    """One model's load outcome: the module if it built, the reason if it did not.

    ``labels`` is populated from the label maps whether or not the weights
    loaded, so the metadata endpoint can describe a model that is currently
    unavailable.
    """

    spec: ModelSpec
    module: torch.nn.Module | None
    labels: list[str]
    loaded: bool
    error: str | None = None
    checkpoint_present: bool = False

    @property
    def model_id(self) -> str:
        return self.spec.id

    @property
    def role(self) -> str:
        return self.spec.role

    def health(self) -> dict[str, Any]:
        """Per-model health block for ``GET /api/health`` (Req 6.6, 10.3)."""
        return {
            "role": self.spec.role,
            "loaded": self.loaded,
            # A loaded module implies its checkpoint was readable, which keeps
            # injected test doubles from reporting an impossible combination.
            "checkpoint_present": bool(self.checkpoint_present or self.loaded),
            "input_size": self.spec.input_size,
            "error": self.error,
        }


def build_specs(settings: Settings | None = None) -> dict[str, ModelSpec]:
    """Build both model specs from settings, primary first.

    Insertion order is the cascade order: ``vit_b16`` then ``efficientnet_b3``.
    """
    cfg = settings or get_settings()
    return {
        VIT_MODEL_ID: ModelSpec(
            id=VIT_MODEL_ID,
            role=PRIMARY_ROLE,
            arch=cfg.vit_arch,
            input_size=cfg.vit_input_size,
            mean=SYMMETRIC_MEAN,
            std=SYMMETRIC_STD,
            checkpoint=cfg.vit_checkpoint_path,
        ),
        EFFNET_MODEL_ID: ModelSpec(
            id=EFFNET_MODEL_ID,
            role=BACKUP_ROLE,
            arch=cfg.effnet_arch,
            input_size=cfg.effnet_input_size,
            mean=IMAGENET_MEAN,
            std=IMAGENET_STD,
            checkpoint=cfg.effnet_checkpoint_path,
        ),
    }


# --- device ----------------------------------------------------------------


def resolve_device(settings: Settings | None = None) -> torch.device:
    """Resolve ``settings.device`` to a concrete ``torch.device``.

    ``"cuda"`` is honoured only when CUDA is actually available; an explicit but
    impossible request falls back to CPU with a warning rather than raising, so a
    stale ``DEVICE=cuda`` in ``.env`` cannot stop the server from booting.
    """
    cfg = settings or get_settings()
    requested = (cfg.device or "auto").lower()

    available = torch.cuda.is_available()
    if requested == "cuda":
        if available:
            return torch.device("cuda")
        log.warning("device=cuda requested but CUDA is not available; falling back to cpu")
        return torch.device("cpu")
    if requested == "auto" and available:
        return torch.device("cuda")
    return torch.device("cpu")


def _apply_thread_limit(settings: Settings) -> None:
    """Apply ``torch.set_num_threads`` once per process, if configured."""
    global _threads_applied

    threads = settings.torch_threads
    if not threads or threads <= 0:
        return
    with _threads_lock:
        if _threads_applied:
            return
        try:
            torch.set_num_threads(int(threads))
        except (ValueError, RuntimeError) as exc:  # pragma: no cover - platform dependent
            log.warning("could not set torch threads to %s: %s", threads, exc)
        else:
            log.info("torch intra-op threads set to %d", int(threads))
        _threads_applied = True


# --- checkpoint reading ----------------------------------------------------


class _LoadFailure(Exception):
    """Internal signal carrying the stable ``error`` code for a failed load."""

    def __init__(self, code: str, detail: str) -> None:
        super().__init__(detail)
        self.code = code
        self.detail = detail


def _read_checkpoint(path: Path, device: torch.device) -> Any:
    """Read a checkpoint, preferring the safe loader.

    ``path`` is passed through as a ``Path``: no formatting, no shell, so a
    filename containing spaces or parentheses needs no quoting (Req 6.2).
    """
    try:
        return torch.load(path, map_location=device, weights_only=True)
    except _UNPICKLING_RETRY_ERRORS as exc:
        log.warning(
            "safe load (weights_only=True) failed for %s: %s; retrying with weights_only=False",
            path,
            exc,
        )
    except OSError as exc:
        raise _LoadFailure("checkpoint_unreadable", f"{path}: {exc}") from exc

    try:
        return torch.load(path, map_location=device, weights_only=False)
    except Exception as exc:  # noqa: BLE001 - any failure here is "unreadable"
        raise _LoadFailure("checkpoint_unreadable", f"{path}: {exc}") from exc


def _extract_state_dict(checkpoint: Any) -> dict[str, torch.Tensor]:
    """Pull the weights out of a checkpoint.

    Searches ``model_state_dict`` then ``state_dict``, and finally treats the
    object itself as the state dict. Both real checkpoints use
    ``model_state_dict``.
    """
    candidate: Any = checkpoint
    if isinstance(checkpoint, Mapping):
        for key in STATE_DICT_KEYS:
            value = checkpoint.get(key)
            if isinstance(value, Mapping) and value:
                candidate = value
                break

    if not isinstance(candidate, Mapping) or not candidate:
        raise _LoadFailure(
            "state_dict_missing",
            f"no state dict under {STATE_DICT_KEYS} or at the top level "
            f"(got {type(checkpoint).__name__})",
        )

    tensors = {
        str(key): value for key, value in candidate.items() if isinstance(value, torch.Tensor)
    }
    if not tensors:
        raise _LoadFailure(
            "state_dict_missing", "the recovered state dict holds no tensors"
        )
    return tensors


def _strip_module_prefix(state_dict: dict[str, torch.Tensor]) -> dict[str, torch.Tensor]:
    """Drop a ``module.`` prefix left by a ``DataParallel`` wrapper."""
    if not any(key.startswith(_MODULE_PREFIX) for key in state_dict):
        return state_dict
    log.info("stripping %r prefix from %d checkpoint keys", _MODULE_PREFIX, len(state_dict))
    return {
        key[len(_MODULE_PREFIX) :] if key.startswith(_MODULE_PREFIX) else key: value
        for key, value in state_dict.items()
    }


def _checkpoint_overrides(checkpoint: Any) -> dict[str, Any]:
    """Read ``model_name`` / ``image_size`` / ``num_classes`` when the file supplies them."""
    overrides: dict[str, Any] = {}
    if not isinstance(checkpoint, Mapping):
        return overrides

    name = checkpoint.get("model_name")
    if isinstance(name, str) and name.strip():
        overrides["arch"] = name.strip()

    for source, target in (("image_size", "input_size"), ("num_classes", "num_classes")):
        value = checkpoint.get(source)
        if isinstance(value, bool):
            continue
        if isinstance(value, int) and value > 0:
            overrides[target] = int(value)
        elif isinstance(value, (list, tuple)) and value and isinstance(value[0], int):
            # Some trainers record image_size as (H, W); a square input is all
            # this architecture supports, so the first element is the size.
            overrides[target] = int(value[0])

    return overrides


# --- label mapping cross-check --------------------------------------------


def _normalise_label_mapping(mapping: Any) -> dict[int, str] | None:
    """Turn any of the plausible ``label_mapping`` shapes into ``{index: name}``.

    Accepts a list in class-id order, ``{"0": "name"}`` / ``{0: "name"}``, and the
    inverted ``{"name": 0}``.
    """
    if isinstance(mapping, Sequence) and not isinstance(mapping, (str, bytes)):
        return {index: str(value) for index, value in enumerate(mapping)}

    if not isinstance(mapping, Mapping) or not mapping:
        return None

    by_index: dict[int, str] = {}
    for key, value in mapping.items():
        try:
            index = int(key)
        except (TypeError, ValueError):
            index = None  # type: ignore[assignment]
        if index is not None:
            by_index[index] = str(value)
            continue
        try:
            by_index[int(value)] = str(key)
        except (TypeError, ValueError):
            return None
    return by_index or None


def verify_label_mapping(mapping: Any, labels: Sequence[str], model_id: str) -> list[str]:
    """Check a checkpoint's embedded ``label_mapping`` against the label map file.

    A mismatch is a warning, not a failure: the label map file is the single
    source of truth for indexing, and a disagreement means the recommendation
    lookup would be describing a different disease than the model predicted. That
    is worth shouting about in the log, but it is not grounds for refusing to
    serve.

    Args:
        mapping: whatever the checkpoint stored under ``label_mapping``.
        labels: the vocabulary loaded from ``data/``, index == class id.
        model_id: for the log line.

    Returns:
        Human-readable mismatch descriptions; empty when the mapping agrees
        index-for-index or when the checkpoint carries no usable mapping.
    """
    by_index = _normalise_label_mapping(mapping)
    if by_index is None:
        return []

    problems: list[str] = []
    if len(by_index) != len(labels):
        problems.append(
            f"checkpoint mapping has {len(by_index)} entries, label map has {len(labels)}"
        )

    for index, expected in enumerate(labels):
        found = by_index.get(index)
        if found is None:
            problems.append(f"index {index}: checkpoint has no entry, label map has {expected!r}")
        elif found != expected:
            problems.append(f"index {index}: checkpoint {found!r} != label map {expected!r}")

    if problems:
        log.warning(
            "%s: embedded label_mapping disagrees with the label map file in %d place(s)",
            model_id,
            len(problems),
        )
        for problem in problems[:10]:
            log.warning("%s: label_mapping mismatch %s", model_id, problem)
    else:
        log.info(
            "%s: embedded label_mapping agrees with the label map file across %d classes",
            model_id,
            len(labels),
        )
    return problems


# --- weight loading -------------------------------------------------------


def _classifier_weight_names(module: torch.nn.Module) -> list[str]:
    """Parameter names of the module's classifier weight matrix.

    Uses timm's own ``get_classifier()`` when available so this works for both
    ``head.weight`` (ViT) and ``classifier.weight`` (EfficientNet) without
    hard-coding either name.
    """
    getter = getattr(module, "get_classifier", None)
    head = getter() if callable(getter) else None
    if head is not None:
        head_ids = {id(param) for param in head.parameters()}
        names = [
            name
            for name, param in module.named_parameters()
            if id(param) in head_ids and param.dim() == 2
        ]
        if names:
            return names

    return [
        name
        for name, param in module.named_parameters()
        if param.dim() == 2 and name.rsplit(".", 1)[0] in ("head", "classifier", "fc")
    ]


def _head_survived(
    module: torch.nn.Module,
    state_dict: Mapping[str, torch.Tensor],
    missing: Sequence[str],
    num_classes: int,
) -> bool:
    """Whether the classifier head really came from the checkpoint, correctly shaped."""
    names = _classifier_weight_names(module)
    if not names:
        log.error("could not locate a classifier weight on %s", type(module).__name__)
        return False

    missing_set = set(missing)
    for name in names:
        if name in missing_set:
            log.error("classifier weight %r was missing from the checkpoint", name)
            return False
        tensor = state_dict.get(name)
        if tensor is None:
            log.error("classifier weight %r is absent from the state dict", name)
            return False
        shape = tuple(tensor.shape)
        if len(shape) != 2 or shape[0] != num_classes:
            log.error(
                "classifier weight %r has shape %s, expected (%d, features)",
                name,
                shape,
                num_classes,
            )
            return False
    return True


def _missing_parameters(module: torch.nn.Module, missing: Sequence[str]) -> list[str]:
    """The subset of ``missing`` that are learnable parameters, not buffers.

    A missing buffer (``num_batches_tracked``, say) is cosmetic. A missing
    parameter means part of the network is still randomly initialised.
    """
    parameter_names = {name for name, _ in module.named_parameters()}
    return [name for name in missing if name in parameter_names]


def _load_weights(
    module: torch.nn.Module,
    state_dict: dict[str, torch.Tensor],
    num_classes: int,
    model_id: str,
) -> None:
    """Load weights strictly, with a narrowly guarded non-strict retry.

    Raises:
        _LoadFailure: the weights do not fit and the non-strict retry could not
            prove that the whole network -- backbone parameters and a correctly
            shaped classifier head -- actually arrived.
    """
    try:
        module.load_state_dict(state_dict, strict=True)
        return
    except RuntimeError as strict_exc:
        log.warning("%s: strict load_state_dict failed: %s", model_id, strict_exc)

    try:
        result = module.load_state_dict(state_dict, strict=False)
    except RuntimeError as exc:
        raise _LoadFailure("weights_mismatch", f"non-strict load also failed: {exc}") from exc

    missing = list(getattr(result, "missing_keys", []))
    unexpected = list(getattr(result, "unexpected_keys", []))
    log.warning(
        "%s: non-strict load produced %d missing and %d unexpected key(s)",
        model_id,
        len(missing),
        len(unexpected),
    )
    if missing:
        log.warning("%s: missing keys %s", model_id, missing[:20])
    if unexpected:
        log.warning("%s: unexpected keys %s", model_id, unexpected[:20])

    missing_params = _missing_parameters(module, missing)
    if missing_params:
        raise _LoadFailure(
            "weights_mismatch",
            f"{len(missing_params)} parameter(s) never loaded, e.g. {missing_params[:5]}",
        )

    if not _head_survived(module, state_dict, missing, num_classes):
        raise _LoadFailure(
            "weights_mismatch",
            "classifier head absent or wrongly shaped after a non-strict load",
        )

    log.warning(
        "%s: accepted after a non-strict load; every parameter and the classifier "
        "head were present, %d checkpoint key(s) were ignored",
        model_id,
        len(unexpected),
    )


def _build_module(arch: str, num_classes: int, input_size: int, takes_img_size: bool):
    """Construct an untrained architecture through timm."""
    kwargs: dict[str, Any] = {"pretrained": False, "num_classes": num_classes}
    if takes_img_size:
        kwargs["img_size"] = input_size
    try:
        return timm.create_model(arch, **kwargs)
    except Exception as exc:  # noqa: BLE001 - timm raises assorted types for a bad arch
        raise _LoadFailure("build_failed", f"timm.create_model({arch!r}) failed: {exc}") from exc


# --- the loader -----------------------------------------------------------

Loader = Callable[[ModelSpec, list[str], torch.device], LoadedModel]
"""Signature of a checkpoint loader; injectable so tests need no weights on disk."""


def load_model(spec: ModelSpec, labels: list[str], device: torch.device) -> LoadedModel:
    """Run the nine-step load sequence for one model.

    Never raises. Every failure becomes ``LoadedModel(loaded=False, error=code)``
    with the path logged, so one broken checkpoint cannot abort startup
    (Req 10.3).
    """
    path = spec.checkpoint

    # 1. existence check
    if not path.exists():
        log.error("%s: checkpoint missing: %s", spec.id, path)
        return LoadedModel(
            spec=spec,
            module=None,
            labels=labels,
            loaded=False,
            error="checkpoint_missing",
            checkpoint_present=False,
        )

    try:
        # 2. read, safe loader first
        checkpoint = _read_checkpoint(path, device)

        # 3. state dict extraction, 4. module. prefix strip
        state_dict = _strip_module_prefix(_extract_state_dict(checkpoint))

        # 5. checkpoint-supplied overrides
        overrides = _checkpoint_overrides(checkpoint)
        num_classes = overrides.pop("num_classes", None) or len(labels)
        if num_classes <= 0:
            # timm reads num_classes=0 as "no classifier at all", which would
            # build a headless backbone and produce features, not logits.
            raise _LoadFailure(
                "state_dict_missing", "no class count from the checkpoint or the label map"
            )
        effective = spec.with_overrides(
            arch=overrides.get("arch"), input_size=overrides.get("input_size")
        )
        if effective.arch != spec.arch or effective.input_size != spec.input_size:
            log.info(
                "%s: checkpoint overrides arch=%s input_size=%d (spec had %s / %d)",
                spec.id,
                effective.arch,
                effective.input_size,
                spec.arch,
                spec.input_size,
            )
        if labels and num_classes != len(labels):
            log.warning(
                "%s: checkpoint declares %d classes but the label map holds %d",
                spec.id,
                num_classes,
                len(labels),
            )

        # 6. build (img_size only for the ViT family)
        module = _build_module(
            effective.arch, num_classes, effective.input_size, effective.takes_img_size
        )

        # 7. load weights
        _load_weights(module, state_dict, num_classes, spec.id)

        # 8. inference mode
        module.eval()
        module.to(device)

        # 9. cross-check the embedded label mapping
        if isinstance(checkpoint, Mapping) and "label_mapping" in checkpoint:
            verify_label_mapping(checkpoint["label_mapping"], labels, spec.id)

    except _LoadFailure as failure:
        log.error("%s: checkpoint unusable (%s): %s", spec.id, failure.code, failure.detail)
        log.error("%s: model marked unavailable; checkpoint path was %s", spec.id, path)
        return LoadedModel(
            spec=spec,
            module=None,
            labels=labels,
            loaded=False,
            error=failure.code,
            checkpoint_present=True,
        )
    except Exception as exc:  # noqa: BLE001 - startup must survive anything torch throws
        log.exception("%s: unexpected failure loading %s: %s", spec.id, path, exc)
        return LoadedModel(
            spec=spec,
            module=None,
            labels=labels,
            loaded=False,
            error="load_failed",
            checkpoint_present=True,
        )

    log.info(
        "%s (%s) loaded: arch=%s input=%d classes=%d device=%s from %s",
        spec.id,
        spec.role,
        effective.arch,
        effective.input_size,
        num_classes,
        device,
        path,
    )
    return LoadedModel(
        spec=effective,
        module=module,
        labels=labels,
        loaded=True,
        error=None,
        checkpoint_present=True,
    )


# --- registry -------------------------------------------------------------


@dataclass(slots=True)
class ModelRegistry:
    """The process-wide holder of both models (Req 6.3).

    Constructed once in the lifespan handler and stored on
    ``app.state.registry``; nothing else in the application builds a model.
    :meth:`get` is safe to call concurrently and loads at most once per model id.
    """

    settings: Settings
    label_maps: LabelMaps
    device: torch.device
    specs: dict[str, ModelSpec]
    loader: Loader = load_model
    _models: dict[str, LoadedModel] = field(default_factory=dict, repr=False)
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    # --- lifecycle ---

    def load_all(self) -> ModelRegistry:
        """Load every model, primary first. Returns ``self`` for chaining.

        Called from startup step 6 so both models are in memory before readiness
        is reported (Req 6.1).
        """
        log_resolved_paths(
            {f"{model_id}_checkpoint": spec.checkpoint for model_id, spec in self.specs.items()},
            logger=log,
        )
        _apply_thread_limit(self.settings)
        for model_id in self.specs:
            self.get(model_id)
        log.info(
            "model registry ready on %s: %s",
            self.device,
            " ".join(
                f"{mid}={'loaded' if m.loaded else f'unavailable({m.error})'}"
                for mid, m in self._models.items()
            ),
        )
        return self

    # --- access ---

    def get(self, model_id: str) -> LoadedModel:
        """Return the single :class:`LoadedModel` for ``model_id``.

        Loads on first access under a lock with a double-checked read, so
        concurrent callers share one instance and the ~1 GB ViT is never loaded
        twice (Req 6.3).

        Raises:
            KeyError: ``model_id`` is not one of the two configured models. This
                is a programming error, not a runtime condition.
        """
        existing = self._models.get(model_id)
        if existing is not None:
            return existing

        spec = self.specs.get(model_id)
        if spec is None:
            raise KeyError(f"unknown model id: {model_id!r}")

        with self._lock:
            existing = self._models.get(model_id)
            if existing is not None:
                return existing
            loaded = self.loader(spec, list(self.label_maps.labels_for(model_id)), self.device)
            self._models[model_id] = loaded
            return loaded

    def set(self, model: LoadedModel) -> None:
        """Install a pre-built :class:`LoadedModel`, for tests and stub registries."""
        with self._lock:
            self.specs[model.spec.id] = model.spec
            self._models[model.spec.id] = model

    @property
    def primary(self) -> LoadedModel:
        """The ViT (Req 5.1)."""
        return self.get(VIT_MODEL_ID)

    @property
    def backup(self) -> LoadedModel:
        """The EfficientNet (Req 5.3)."""
        return self.get(EFFNET_MODEL_ID)

    def models(self) -> dict[str, LoadedModel]:
        """Every model in cascade order, loading any not yet touched."""
        return {model_id: self.get(model_id) for model_id in self.specs}

    def any_loaded(self) -> bool:
        """Whether at least one model can serve a prediction (Req 10.5)."""
        return any(model.loaded for model in self.models().values())

    # --- health ---

    def status(self) -> str:
        """``ok`` when every model is loaded, ``degraded`` when some, else ``unavailable``."""
        states = [model.loaded for model in self.models().values()]
        if states and all(states):
            return "ok"
        if any(states):
            return "degraded"
        return "unavailable"

    def model_states(self) -> dict[str, dict[str, Any]]:
        """Per-model health blocks, keyed by model id (Req 6.6, 10.3)."""
        return {model_id: model.health() for model_id, model in self.models().items()}

    def health(self) -> dict[str, Any]:
        """The registry's contribution to ``GET /api/health``."""
        return {
            "status": self.status(),
            "device": str(self.device),
            "models": self.model_states(),
        }


def build_registry(
    settings: Settings | None = None,
    label_maps: LabelMaps | None = None,
    *,
    loader: Loader = load_model,
    load: bool = True,
) -> ModelRegistry:
    """Build the one registry the application uses.

    Args:
        settings: defaults to :func:`app.config.get_settings`.
        label_maps: the already-loaded vocabularies from startup step 3; loaded
            here if omitted.
        loader: injection point for tests, which supply a counting stub so no
            weights need to exist on disk.
        load: load both checkpoints immediately (startup step 6). ``False`` defers
            to first :meth:`ModelRegistry.get`.
    """
    cfg = settings or get_settings()
    maps = label_maps if label_maps is not None else load_label_maps(cfg)
    registry = ModelRegistry(
        settings=cfg,
        label_maps=maps,
        device=resolve_device(cfg),
        specs=build_specs(cfg),
        loader=loader,
    )
    return registry.load_all() if load else registry
