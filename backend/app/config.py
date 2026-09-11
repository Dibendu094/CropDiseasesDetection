"""Application configuration.

All filesystem locations live here, are typed ``Path``, and are resolved to
absolute paths at construction time. Path composition uses ``Path.__truediv__``
exclusively, which is how Requirement 6.2 is satisfied: the space and
parentheses in ``vit_b16_epoch_02 (2).pth`` never reach a shell or a format
string, so no quoting is ever needed.

Environment variable names are the field names upper-cased (``MODELS_DIR``,
``CONFIDENCE_THRESHOLD``, ``EFFNET_INPUT_SIZE``, ``CORS_ALLOW_ORIGINS``,
``DEVICE``, ``MAX_UPLOAD_BYTES``, ...). A ``backend/.env`` file is read if
present.

Relative path overrides resolve against ``BACKEND_DIR`` -- never against the
process working directory -- so ``MODELS_DIR=../models`` means the same thing
whether uvicorn is launched from ``backend/`` or from the repository root.
"""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Annotated, Literal

from pydantic import field_validator
try:
    from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict
except ImportError:
    from pydantic_settings import BaseSettings, SettingsConfigDict  # type: ignore[assignment]

    class _NoDecode:
        pass

    NoDecode = _NoDecode  # type: ignore[assignment]

# backend/app/config.py -> parents[0] = app, parents[1] = backend, parents[2] = repo root
BACKEND_DIR: Path = Path(__file__).resolve().parents[1]
REPO_ROOT: Path = Path(__file__).resolve().parents[2]


def _resolve_against_backend(value: Path) -> Path:
    """Make ``value`` absolute, treating relative paths as relative to ``BACKEND_DIR``."""
    path = Path(value).expanduser()
    if not path.is_absolute():
        path = BACKEND_DIR / path
    return path.resolve()


def _split_list(value: object) -> object:
    """Accept a JSON array or a comma-separated string for list-ish settings."""
    if not isinstance(value, str):
        return value
    text = value.strip()
    if not text:
        return []
    if text.startswith("["):
        return json.loads(text)
    return [item.strip() for item in text.split(",") if item.strip()]


class Settings(BaseSettings):
    """Process-wide settings. Construct through :func:`get_settings`."""

    model_config = SettingsConfigDict(
        env_file=BACKEND_DIR / ".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    # --- paths (decision D1: checkpoints and data stay at the repo root) ---
    models_dir: Path = REPO_ROOT / "models"
    data_dir: Path = REPO_ROOT / "data"
    uploads_dir: Path = BACKEND_DIR / "uploads"
    db_path: Path = BACKEND_DIR / "history.db"

    vit_checkpoint_name: str = "vit_b16_epoch_02 (2).pth"
    effnet_checkpoint_name: str = "best_epoch_4_acc_98.70.pth"
    vit_labels_name: str = "names (3).json"
    effnet_labels_name: str = "class_names.json"
    disease_info_name: str = "disease_info.json"
    disease_info_ext_name: str = "disease_info_ext.json"

    # --- inference ---
    confidence_threshold: float = 0.70
    vit_arch: str = "vit_base_patch16_384"
    vit_input_size: int = 384
    effnet_arch: str = "efficientnet_b3"
    effnet_input_size: int = 300
    num_classes: int = 91
    device: Literal["auto", "cpu", "cuda"] = "auto"
    torch_threads: int | None = None

    # --- uploads ---
    max_upload_bytes: int = 10 * 1024 * 1024
    allowed_formats: Annotated[tuple[str, ...], NoDecode] = ("JPEG", "PNG", "WEBP")

    # --- http ---
    cors_allow_origins: Annotated[list[str], NoDecode] = [
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    ]
    log_level: str = "INFO"

    # --- validators ---

    @field_validator("models_dir", "data_dir", "uploads_dir", "db_path", mode="after")
    @classmethod
    def _absolutize(cls, value: Path) -> Path:
        return _resolve_against_backend(value)

    @field_validator("cors_allow_origins", mode="before")
    @classmethod
    def _parse_origins(cls, value: object) -> object:
        return _split_list(value)

    @field_validator("allowed_formats", mode="before")
    @classmethod
    def _parse_formats(cls, value: object) -> object:
        parsed = _split_list(value)
        if isinstance(parsed, (list, tuple)):
            return tuple(str(item).strip().upper() for item in parsed)
        return parsed

    # --- resolved paths ---

    @property
    def vit_checkpoint_path(self) -> Path:
        return self.models_dir / self.vit_checkpoint_name

    @property
    def effnet_checkpoint_path(self) -> Path:
        return self.models_dir / self.effnet_checkpoint_name

    @property
    def vit_labels_path(self) -> Path:
        return self.data_dir / self.vit_labels_name

    @property
    def effnet_labels_path(self) -> Path:
        return self.data_dir / self.effnet_labels_name

    @property
    def disease_info_path(self) -> Path:
        return self.data_dir / self.disease_info_name

    @property
    def disease_info_ext_path(self) -> Path:
        return self.data_dir / self.disease_info_ext_name

    def resolved_paths(self) -> dict[str, Path]:
        """Every path the application touches, for the startup path log."""
        return {
            "models_dir": self.models_dir,
            "data_dir": self.data_dir,
            "uploads_dir": self.uploads_dir,
            "db_path": self.db_path,
            "vit_checkpoint": self.vit_checkpoint_path,
            "effnet_checkpoint": self.effnet_checkpoint_path,
            "vit_labels": self.vit_labels_path,
            "effnet_labels": self.effnet_labels_path,
            "disease_info": self.disease_info_path,
            "disease_info_ext": self.disease_info_ext_path,
        }


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Return the process-wide :class:`Settings` instance."""
    return Settings()
