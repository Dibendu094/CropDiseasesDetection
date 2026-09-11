"""Error taxonomy for the crop disease detection API.

One base class, one envelope shape: ``{"error": {"code": ..., "message": ...}}``.

Every exception here carries its own HTTP status, a stable machine-readable
``code``, and a user-visible ``message`` written for a grower, not a developer.
Messages never interpolate exception text, file paths, or tracebacks, so an
error body cannot leak the filesystem layout (Req 10.6).

The exception handlers that turn these into responses live in ``app.main``.
"""

from __future__ import annotations

from typing import Any

__all__ = [
    "INTERNAL_ERROR_CODE",
    "INTERNAL_ERROR_MESSAGE",
    "ApiError",
    "MissingImageError",
    "BadRequestError",
    "PayloadTooLargeError",
    "UnsupportedMediaTypeError",
    "UnreadableImageError",
    "InvalidQueryError",
    "NotFoundError",
    "ImageMissingError",
    "ServiceUnavailableError",
    "error_envelope",
]


# --- catch-all handler constants (Req 10.6) --------------------------------
# The 500 handler logs exc_info=True server-side and returns *only* this
# static string. It is deliberately not an ApiError subclass: nothing in the
# application raises it, it is what an unhandled Exception degrades to.
INTERNAL_ERROR_CODE = "INTERNAL_ERROR"
INTERNAL_ERROR_MESSAGE = (
    "Something went wrong while analysing the image. Please try again."
)


class ApiError(Exception):
    """Base for every error the API reports with a defined envelope.

    Subclasses set ``status``, ``code``, and ``message`` as class attributes.
    Instances may override the message when a narrower explanation helps, but
    the default is always the taxonomy's text.
    """

    status: int = 500
    code: str = INTERNAL_ERROR_CODE
    message: str = INTERNAL_ERROR_MESSAGE

    def __init__(self, message: str | None = None) -> None:
        if message is not None:
            self.message = message
        super().__init__(self.message)

    def to_dict(self) -> dict[str, Any]:
        """Return this error as the response envelope body."""
        return error_envelope(self.code, self.message)

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return (
            f"{type(self).__name__}(status={self.status}, "
            f"code={self.code!r}, message={self.message!r})"
        )


# --- 400 -------------------------------------------------------------------


class MissingImageError(ApiError):
    """No image file was attached to a prediction request (Req 10.1)."""

    status = 400
    code = "IMAGE_REQUIRED"
    message = "An image is required. Attach a photo and try again."


class BadRequestError(ApiError):
    """A supplied image reference is malformed or out of bounds (Req 4.6)."""

    status = 400
    code = "BAD_REQUEST"
    message = "Invalid image reference."


# --- 413 -------------------------------------------------------------------


class PayloadTooLargeError(ApiError):
    """The upload exceeds ``max_upload_bytes`` (Req 4.3)."""

    status = 413
    code = "IMAGE_TOO_LARGE"
    message = (
        "That image is larger than the 10 MB limit. Please use a smaller photo."
    )


# --- 415 -------------------------------------------------------------------


class UnsupportedMediaTypeError(ApiError):
    """The upload is not one of the accepted image formats (Req 4.2)."""

    status = 415
    code = "UNSUPPORTED_FORMAT"
    message = "Only JPEG, PNG, and WebP images are accepted."


# --- 422 -------------------------------------------------------------------


class UnreadableImageError(ApiError):
    """The bytes could not be decoded as an image (Req 10.2)."""

    status = 422
    code = "IMAGE_UNREADABLE"
    message = "That image could not be read. It may be incomplete or corrupted."


class InvalidQueryError(ApiError):
    """Query parameters failed validation."""

    status = 422
    code = "INVALID_QUERY"
    message = "Invalid query parameters."


# --- 404 -------------------------------------------------------------------


class NotFoundError(ApiError):
    """The requested history entry does not exist (Req 9.9)."""

    status = 404
    code = "NOT_FOUND"
    message = "That history entry does not exist."


class ImageMissingError(ApiError):
    """The entry exists but its stored image file is gone (Req 9.3)."""

    status = 404
    code = "IMAGE_MISSING"
    message = "The stored image for that entry is no longer available."


# --- 503 -------------------------------------------------------------------


class ServiceUnavailableError(ApiError):
    """Neither the primary nor the backup model is loaded (Req 10.5)."""

    status = 503
    code = "MODELS_UNAVAILABLE"
    message = "The diagnosis service is unavailable. No model is loaded."


def error_envelope(code: str, message: str) -> dict[str, Any]:
    """Build the single error body shape the frontend parses.

    >>> error_envelope("NOT_FOUND", "That history entry does not exist.")
    {'error': {'code': 'NOT_FOUND', 'message': 'That history entry does not exist.'}}
    """
    return {"error": {"code": code, "message": message}}
