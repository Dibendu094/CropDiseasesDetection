"""Error taxonomy tests.

Locks ``app.errors`` to the table in the design document: one row per exception,
each with a fixed HTTP status, a stable machine-readable ``code``, and a
user-visible message. Also pins the single envelope shape the frontend parses,
``{"error": {"code": ..., "message": ...}}``.

Requirements: 10.1 (400 IMAGE_REQUIRED), 10.2 (422 IMAGE_UNREADABLE),
10.5 (503 MODELS_UNAVAILABLE), and the surrounding rows of the same table.

Later sections (added by task 9.9) exercise the taxonomy through the HTTP
surface: the leak-prevention property and CORS behaviour. Keep this file
organised as: taxonomy table -> envelope -> base-class behaviour -> HTTP.
"""

from __future__ import annotations

import inspect

import pytest

from app import errors
from app.errors import (
    INTERNAL_ERROR_CODE,
    INTERNAL_ERROR_MESSAGE,
    ApiError,
    BadRequestError,
    ImageMissingError,
    InvalidQueryError,
    MissingImageError,
    NotFoundError,
    PayloadTooLargeError,
    ServiceUnavailableError,
    UnreadableImageError,
    UnsupportedMediaTypeError,
    error_envelope,
)

# --- the design's error taxonomy table, transcribed ------------------------
# (exception, status, code, message)
TAXONOMY: list[tuple[type[ApiError], int, str, str]] = [
    (
        MissingImageError,
        400,
        "IMAGE_REQUIRED",
        "An image is required. Attach a photo and try again.",
    ),
    (BadRequestError, 400, "BAD_REQUEST", "Invalid image reference."),
    (
        PayloadTooLargeError,
        413,
        "IMAGE_TOO_LARGE",
        "That image is larger than the 10 MB limit. Please use a smaller photo.",
    ),
    (
        UnsupportedMediaTypeError,
        415,
        "UNSUPPORTED_FORMAT",
        "Only JPEG, PNG, and WebP images are accepted.",
    ),
    (
        UnreadableImageError,
        422,
        "IMAGE_UNREADABLE",
        "That image could not be read. It may be incomplete or corrupted.",
    ),
    (InvalidQueryError, 422, "INVALID_QUERY", "Invalid query parameters."),
    (NotFoundError, 404, "NOT_FOUND", "That history entry does not exist."),
    (
        ImageMissingError,
        404,
        "IMAGE_MISSING",
        "The stored image for that entry is no longer available.",
    ),
    (
        ServiceUnavailableError,
        503,
        "MODELS_UNAVAILABLE",
        "The diagnosis service is unavailable. No model is loaded.",
    ),
]

TAXONOMY_IDS = [row[0].__name__ for row in TAXONOMY]


# --- taxonomy rows ---------------------------------------------------------


@pytest.mark.parametrize(("exc_type", "status", "code", "message"), TAXONOMY, ids=TAXONOMY_IDS)
def test_taxonomy_row_matches_design(
    exc_type: type[ApiError], status: int, code: str, message: str
) -> None:
    """Status, code, and message match the design table on the class and the instance."""
    assert exc_type.status == status
    assert exc_type.code == code
    assert exc_type.message == message

    instance = exc_type()
    assert instance.status == status
    assert instance.code == code
    assert instance.message == message
    assert str(instance) == message


@pytest.mark.parametrize(("exc_type", "status", "code", "message"), TAXONOMY, ids=TAXONOMY_IDS)
def test_taxonomy_row_serialises_to_envelope(
    exc_type: type[ApiError], status: int, code: str, message: str
) -> None:
    """Requirements 10.1, 10.2, 10.5: every row renders as the one envelope shape."""
    assert exc_type().to_dict() == {"error": {"code": code, "message": message}}


def test_every_api_error_subclass_is_in_the_table() -> None:
    """No subclass may exist without a documented status/code pair."""
    declared = {
        obj
        for _, obj in inspect.getmembers(errors, inspect.isclass)
        if issubclass(obj, ApiError) and obj is not ApiError
    }
    assert declared == {row[0] for row in TAXONOMY}


def test_codes_are_unique() -> None:
    """Codes are the frontend's switch keys, so they must not collide."""
    codes = [row[2] for row in TAXONOMY]
    assert len(set(codes)) == len(codes)


@pytest.mark.parametrize(("exc_type", "status", "code", "message"), TAXONOMY, ids=TAXONOMY_IDS)
def test_every_error_is_raisable_and_catchable_as_api_error(
    exc_type: type[ApiError], status: int, code: str, message: str
) -> None:
    with pytest.raises(ApiError) as caught:
        raise exc_type()
    assert caught.value.status == status


# --- envelope shape --------------------------------------------------------


def test_error_envelope_shape() -> None:
    body = error_envelope("NOT_FOUND", "That history entry does not exist.")
    assert set(body) == {"error"}
    assert set(body["error"]) == {"code", "message"}
    assert body == {
        "error": {"code": "NOT_FOUND", "message": "That history entry does not exist."}
    }


@pytest.mark.parametrize(("exc_type", "status", "code", "message"), TAXONOMY, ids=TAXONOMY_IDS)
def test_to_dict_has_no_extra_keys(
    exc_type: type[ApiError], status: int, code: str, message: str
) -> None:
    body = exc_type().to_dict()
    assert set(body) == {"error"}
    assert set(body["error"]) == {"code", "message"}
    assert all(isinstance(value, str) for value in body["error"].values())


# --- base class and catch-all ----------------------------------------------


def test_message_override_keeps_status_and_code() -> None:
    """An instance may narrow the message; status and code stay taxonomy-owned."""
    err = InvalidQueryError("limit must be between 1 and 100.")
    assert err.message == "limit must be between 1 and 100."
    assert err.status == 422
    assert err.code == "INVALID_QUERY"
    assert err.to_dict()["error"]["message"] == "limit must be between 1 and 100."
    # The class default is untouched by the instance override.
    assert InvalidQueryError.message == "Invalid query parameters."
    assert InvalidQueryError().message == "Invalid query parameters."


def test_api_error_base_defaults_to_the_catch_all_row() -> None:
    assert ApiError.status == 500
    assert ApiError.code == INTERNAL_ERROR_CODE == "INTERNAL_ERROR"
    assert ApiError.message == INTERNAL_ERROR_MESSAGE
    assert INTERNAL_ERROR_MESSAGE == (
        "Something went wrong while analysing the image. Please try again."
    )


def test_no_message_leaks_paths_or_tracebacks() -> None:
    """Requirement 10.6: user-visible text carries no filesystem or stack detail."""
    messages = [row[3] for row in TAXONOMY] + [INTERNAL_ERROR_MESSAGE]
    for message in messages:
        lowered = message.lower()
        assert "traceback" not in lowered
        assert "\\" not in message
        assert ".pth" not in lowered
        assert "d:" not in lowered
        assert "crop_diseases_prediction" not in lowered
