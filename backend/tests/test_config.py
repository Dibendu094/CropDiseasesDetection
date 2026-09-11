"""Configuration tests.

Requirement 6.2: the Primary_Model checkpoint path preserves the space and the
parentheses in ``vit_b16_epoch_02 (2).pth``. It does so structurally --
``Path.__truediv__`` composition, no shell, no format strings -- so the test
asserts on ``Path`` parts rather than on quoting.

Also pins decision D1: ``models_dir`` and ``data_dir`` point at the existing
root-level ``models/`` and ``data/`` directories, and relative overrides resolve
against ``backend/`` rather than the process working directory.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from app.config import BACKEND_DIR, REPO_ROOT, Settings, get_settings

VIT_CHECKPOINT_FILENAME = "vit_b16_epoch_02 (2).pth"
EFFNET_CHECKPOINT_FILENAME = "best_epoch_4_acc_98.70.pth"


@pytest.fixture
def settings() -> Settings:
    """A fresh, uncached Settings so one test's env cannot bleed into another."""
    return Settings()


# --- anchors ---------------------------------------------------------------


def test_repo_root_and_backend_dir_anchors() -> None:
    assert BACKEND_DIR == REPO_ROOT / "backend"
    assert (BACKEND_DIR / "app" / "config.py").is_file()
    assert BACKEND_DIR.is_absolute()
    assert REPO_ROOT.is_absolute()


# --- decision D1: checkpoints and data stay at the repo root ---------------


def test_models_and_data_dirs_resolve_to_existing_root_level_directories(
    settings: Settings,
) -> None:
    assert settings.models_dir == REPO_ROOT / "models"
    assert settings.data_dir == REPO_ROOT / "data"
    assert settings.models_dir.is_dir()
    assert settings.data_dir.is_dir()


def test_uploads_and_db_live_under_backend(settings: Settings) -> None:
    assert settings.uploads_dir == BACKEND_DIR / "uploads"
    assert settings.db_path == BACKEND_DIR / "history.db"


def test_every_resolved_path_is_absolute(settings: Settings) -> None:
    resolved = settings.resolved_paths()
    assert resolved  # the startup path log has something to say
    for name, path in resolved.items():
        assert isinstance(path, Path), name
        assert path.is_absolute(), name


# --- Requirement 6.2: the awkward checkpoint filename ---------------------


def test_vit_checkpoint_path_preserves_space_and_parentheses(settings: Settings) -> None:
    path = settings.vit_checkpoint_path
    assert path.name == VIT_CHECKPOINT_FILENAME
    assert path.parent == settings.models_dir
    assert path == settings.models_dir / VIT_CHECKPOINT_FILENAME
    # No shell escaping, no added quotes, no collapsed whitespace.
    assert " " in path.name
    assert "(" in path.name and ")" in path.name
    assert '"' not in str(path)
    assert "\\ " not in str(path)


def test_checkpoint_and_data_paths_are_composed_from_their_directories(
    settings: Settings,
) -> None:
    assert settings.effnet_checkpoint_path == settings.models_dir / EFFNET_CHECKPOINT_FILENAME
    assert settings.vit_labels_path == settings.data_dir / "names (3).json"
    assert settings.effnet_labels_path == settings.data_dir / "class_names.json"
    assert settings.disease_info_path == settings.data_dir / "disease_info.json"
    assert settings.disease_info_ext_path == settings.data_dir / "disease_info_ext.json"


def test_data_files_exist_on_disk(settings: Settings) -> None:
    for path in (
        settings.vit_labels_path,
        settings.effnet_labels_path,
        settings.disease_info_path,
        settings.disease_info_ext_path,
    ):
        assert path.is_file(), path


@pytest.mark.checkpoints
def test_checkpoint_files_exist_on_disk(settings: Settings) -> None:
    """Deselected by default; the paths above are asserted without touching the weights."""
    assert settings.vit_checkpoint_path.is_file()
    assert settings.effnet_checkpoint_path.is_file()


# --- override resolution ---------------------------------------------------


def test_relative_override_resolves_against_backend_not_cwd(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """``MODELS_DIR=../models`` means the same thing from any working directory."""
    (tmp_path / "models").mkdir()  # a decoy the CWD-relative reading would find
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("MODELS_DIR", "../models")

    resolved = Settings().models_dir

    assert resolved == REPO_ROOT / "models"
    assert resolved != (tmp_path / "models").resolve()
    assert resolved.is_dir()


def test_defaults_are_independent_of_cwd(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.chdir(tmp_path)
    from_tmp = Settings()
    monkeypatch.chdir(BACKEND_DIR)
    from_backend = Settings()

    assert from_tmp.models_dir == from_backend.models_dir == REPO_ROOT / "models"
    assert from_tmp.data_dir == from_backend.data_dir == REPO_ROOT / "data"
    assert from_tmp.uploads_dir == from_backend.uploads_dir


def test_absolute_override_is_honoured(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    custom = tmp_path / "weights"
    custom.mkdir()
    monkeypatch.setenv("MODELS_DIR", str(custom))

    settings = Settings()

    assert settings.models_dir == custom.resolve()
    assert settings.vit_checkpoint_path == custom.resolve() / VIT_CHECKPOINT_FILENAME


def test_checkpoint_name_override_flows_into_the_path(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("VIT_CHECKPOINT_NAME", "another epoch (7).pth")
    settings = Settings()
    assert settings.vit_checkpoint_path.name == "another epoch (7).pth"


# --- inference and upload defaults the design fixes -----------------------


def test_inference_and_upload_defaults(settings: Settings) -> None:
    assert settings.confidence_threshold == pytest.approx(0.70)
    assert settings.vit_input_size == 384
    assert settings.effnet_input_size == 300
    assert settings.num_classes == 91
    assert settings.max_upload_bytes == 10 * 1024 * 1024
    assert settings.device == "auto"
    assert settings.allowed_formats == ("JPEG", "PNG", "WEBP")


def test_cors_origins_are_an_explicit_list(settings: Settings) -> None:
    assert settings.cors_allow_origins == [
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    ]
    assert "*" not in settings.cors_allow_origins


def test_comma_separated_list_env_overrides(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CORS_ALLOW_ORIGINS", "http://a.test, http://b.test")
    monkeypatch.setenv("ALLOWED_FORMATS", "jpeg, png")

    settings = Settings()

    assert settings.cors_allow_origins == ["http://a.test", "http://b.test"]
    assert settings.allowed_formats == ("JPEG", "PNG")


def test_json_list_env_override(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CORS_ALLOW_ORIGINS", '["http://a.test"]')
    assert Settings().cors_allow_origins == ["http://a.test"]


def test_invalid_device_is_rejected(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DEVICE", "tpu")
    with pytest.raises(ValueError):
        Settings()


# --- caching ---------------------------------------------------------------


def test_get_settings_is_cached() -> None:
    try:
        assert get_settings() is get_settings()
    finally:
        get_settings.cache_clear()


def test_cache_clear_rebuilds_the_instance() -> None:
    first = get_settings()
    get_settings.cache_clear()
    try:
        second = get_settings()
        assert second is not first
        assert second.models_dir == first.models_dir
    finally:
        get_settings.cache_clear()
