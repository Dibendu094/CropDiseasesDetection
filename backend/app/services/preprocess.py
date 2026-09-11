"""Turn a decoded photo into the input tensor a checkpoint expects (Req 5.8).

One code path serves both models. The only things that differ are constants the
:class:`SpecLike` argument carries — ``input_size``, ``mean`` and ``std`` — so the
ViT pipeline and the EfficientNet pipeline cannot drift apart:

===============  =====  =========================  =========================
model            size   mean                       std
===============  =====  =========================  =========================
vit_b16          384    (0.5, 0.5, 0.5)            (0.5, 0.5, 0.5)
efficientnet_b3  300    (0.485, 0.456, 0.406)      (0.229, 0.224, 0.225)
===============  =====  =========================  =========================

The chain, in order: EXIF transpose, convert to ``RGB``, bicubic resize to a
square, scale to ``[0, 1]``, subtract the mean, divide by the std, and hand back a
``(1, 3, S, S)`` float32 tensor.

Three decisions worth stating outright:

* **Resize, never centre-crop** (design D4). ``vit_base_patch16_384`` declares
  ``crop_pct = 1.0``, so a straight resize *is* its canonical pipeline. timm's
  default for EfficientNet-B3 would crop 12.5% of the frame away, and a leaf
  lesion is frequently off-centre. Aspect distortion is accepted; losing the
  lesion is not.
* **No torchvision** (design D2). Pillow resizes, NumPy normalises. That is a
  dozen lines and one fewer dependency whose version has to track torch's.
* **Decode once per request.** :func:`decode_image` produces one ``PIL.Image``
  and :func:`to_tensors` feeds that same object to every spec, sharing the EXIF
  and colour-mode work. A confidence cascade that consults the backup model must
  not pay for a second JPEG decode.

This module deliberately imports nothing from ``model_registry``. It accepts any
object satisfying :class:`SpecLike`, which the real ``ModelSpec`` does
structurally, so preprocessing stays testable on a machine with no checkpoints
and there is no import cycle between the registry and the transform.
"""

from __future__ import annotations

import io
from typing import Iterable, Protocol, Sequence, runtime_checkable

import numpy as np
import torch
from PIL import Image, ImageOps, UnidentifiedImageError

from ..errors import UnreadableImageError
from ..logging_config import get_logger

__all__ = [
    "RESAMPLE",
    "SpecLike",
    "decode_image",
    "prepare_source",
    "to_tensor",
    "to_tensors",
]

log = get_logger(__name__)

RESAMPLE = Image.Resampling.BICUBIC
"""Both checkpoints declare bicubic interpolation in their timm default cfg."""

_CHANNELS = 3


@runtime_checkable
class SpecLike(Protocol):
    """The three fields preprocessing needs from a model spec.

    ``app.services.model_registry.ModelSpec`` satisfies this structurally; so does
    any small stand-in a test cares to build. Declaring the dependency this way
    rather than importing ``ModelSpec`` keeps the import graph acyclic — the
    registry builds models, and models need the transform.
    """

    @property
    def input_size(self) -> int:
        """Side length ``S`` of the square input, in pixels."""

    @property
    def mean(self) -> Sequence[float]:
        """Per-channel mean, in RGB order, on the ``[0, 1]`` scale."""

    @property
    def std(self) -> Sequence[float]:
        """Per-channel standard deviation, in RGB order, all non-zero."""


def decode_image(data: bytes | bytearray | memoryview) -> Image.Image:
    """Decode image bytes once, for the whole request.

    The returned image is fully loaded into memory, so the caller may close the
    source buffer and still hand the same object to :func:`to_tensors` for both
    models.

    Args:
        data: raw upload bytes.

    Returns:
        A decoded ``PIL.Image``, in whatever mode the file declares. Mode
        normalisation happens in :func:`prepare_source`, not here.

    Raises:
        UnreadableImageError: the bytes are not a decodable image, or are a
            truncated one. Surfaces as ``422 IMAGE_UNREADABLE`` (Req 10.2).
    """
    try:
        image = Image.open(io.BytesIO(bytes(data)))
        image.load()  # force the decode now, so truncation fails here and not mid-inference
    except (UnidentifiedImageError, OSError, ValueError, SyntaxError) as exc:
        # Pillow reports truncation as OSError and some malformed headers as
        # SyntaxError. The message is dropped on purpose: no library internals in
        # a user-facing body (Req 10.6).
        log.info("image decode failed: %s: %s", type(exc).__name__, exc)
        raise UnreadableImageError from exc
    return image


def prepare_source(image: Image.Image) -> Image.Image:
    """Apply EXIF orientation and normalise the colour mode to ``RGB``.

    This is the half of the pipeline that does not depend on the spec, so it runs
    once even when both models are consulted.

    Args:
        image: any decoded ``PIL.Image`` — ``L``, ``LA``, ``P``, ``RGBA``,
            ``CMYK``, ``I``, ``F`` and the rest all land on ``RGB``.

    Returns:
        An ``RGB`` image, upright.

    Raises:
        UnreadableImageError: the image has a zero-width or zero-height axis, or
            its mode cannot be converted to ``RGB``. Both are unusable rather
            than merely awkward, so they are reported like any other bad upload.
    """
    # Phone photos arrive rotated: the pixels are landscape and an EXIF tag says
    # "display this portrait". exif_transpose bakes the tag into the pixels.
    # It returns None for an in-place call on some Pillow versions, and older
    # releases can return None when the EXIF block is malformed, so never chain
    # off it directly.
    try:
        rotated = ImageOps.exif_transpose(image)
    except Exception as exc:  # pragma: no cover - corrupt EXIF, orientation is optional
        log.debug("exif_transpose failed, using original orientation: %s", exc)
        rotated = None
    img = rotated if rotated is not None else image

    width, height = img.size
    if width <= 0 or height <= 0:
        log.info("image has an empty axis: %dx%d", width, height)
        raise UnreadableImageError

    if img.mode == "RGB":
        return img

    try:
        return img.convert("RGB")
    except ValueError as exc:
        # Pillow has no direct path from some raw modes (16-bit and float
        # greyscale, notably "I;16") to RGB. Step through "L" first, which it
        # does support, rather than rejecting a decodable image.
        try:
            return img.convert("L").convert("RGB")
        except (ValueError, OSError) as inner:
            log.info("cannot convert mode %r to RGB: %s / %s", img.mode, exc, inner)
            raise UnreadableImageError from inner


def to_tensor(image: Image.Image, spec: SpecLike) -> torch.Tensor:
    """Preprocess ``image`` for ``spec`` and return a ``(1, 3, S, S)`` batch.

    Args:
        image: a decoded ``PIL.Image`` in any mode and at any pixel size.
        spec: carries ``input_size``, ``mean`` and ``std``.

    Returns:
        A float32 tensor of shape ``(1, 3, spec.input_size, spec.input_size)``,
        channel-first, contiguous, normalised so that a pixel of value
        ``mean[c] * 255`` maps to ``0.0`` on channel ``c``. Every element is
        finite: the source is 8-bit RGB after conversion, so values before
        normalisation are exactly ``[0, 1]``, and ``std`` is checked non-zero.

    Raises:
        ValueError: ``spec`` declares a non-positive ``input_size``, a mean or std
            that is not three numbers, or a zero in ``std``.
        UnreadableImageError: the image cannot be brought to ``RGB``.
    """
    return _transform(prepare_source(image), spec)


def to_tensors(image: Image.Image, specs: Iterable[SpecLike]) -> list[torch.Tensor]:
    """Preprocess one image for several specs, sharing the decode.

    Equivalent to ``[to_tensor(image, s) for s in specs]`` but the EXIF transpose
    and the ``RGB`` conversion run once instead of once per model. That is the
    "decode once, feed both pipelines" path the cascade uses when the primary
    model falls below the confidence threshold.

    Args:
        image: a decoded ``PIL.Image``, typically straight from
            :func:`decode_image`.
        specs: the specs to build tensors for, in the order the caller wants them
            back.

    Returns:
        One tensor per spec, in the same order.
    """
    source = prepare_source(image)
    return [_transform(source, spec) for spec in specs]


def _transform(source: Image.Image, spec: SpecLike) -> torch.Tensor:
    """Resize, scale and normalise an already-``RGB`` image. See :func:`to_tensor`."""
    size = _validate_size(spec)
    mean, std = _validate_normalisation(spec)

    # D4: the whole frame is squeezed into the square. No centre crop, so a lesion
    # near an edge survives.
    resized = source if source.size == (size, size) else source.resize((size, size), RESAMPLE)

    arr = np.asarray(resized, dtype=np.float32) / 255.0  # (S, S, 3) in [0, 1]
    if arr.shape != (size, size, _CHANNELS):  # pragma: no cover - guards a Pillow surprise
        raise ValueError(
            f"expected an ({size}, {size}, {_CHANNELS}) array after resize, got {arr.shape}"
        )

    arr = (arr - mean) / std

    # permute() alone leaves a non-contiguous view; contiguous() makes the memory
    # layout what a conv/patch-embed kernel expects.
    return torch.from_numpy(arr).permute(2, 0, 1).unsqueeze(0).contiguous()


def _validate_size(spec: SpecLike) -> int:
    size = spec.input_size
    if not isinstance(size, (int, np.integer)) or isinstance(size, bool) or int(size) <= 0:
        raise ValueError(f"spec.input_size must be a positive integer, got {size!r}")
    return int(size)


def _validate_normalisation(spec: SpecLike) -> tuple[np.ndarray, np.ndarray]:
    mean = _as_channel_vector(spec.mean, name="mean")
    std = _as_channel_vector(spec.std, name="std")
    if not np.all(np.isfinite(mean)) or not np.all(np.isfinite(std)):
        raise ValueError(f"spec.mean/std must be finite, got mean={spec.mean!r} std={spec.std!r}")
    if np.any(std == 0.0):
        # A zero std would divide the tensor into infinities and quietly poison
        # every logit downstream, so refuse it here where the cause is obvious.
        raise ValueError(f"spec.std must not contain zero, got {spec.std!r}")
    return mean, std


def _as_channel_vector(values: Sequence[float], *, name: str) -> np.ndarray:
    vector = np.asarray(tuple(values), dtype=np.float32)
    if vector.shape != (_CHANNELS,):
        raise ValueError(f"spec.{name} must hold {_CHANNELS} values, got {values!r}")
    return vector
