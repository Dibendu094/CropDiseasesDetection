import sqlite3
import pytest
from pathlib import Path
from app.config import Settings
from app.db.database import init_db
from app.db.repository import ScanCandidate, ScanRecord, ScanRepository
from app.main import create_app
from fastapi.testclient import TestClient

@pytest.fixture
def temp_repo(tmp_path: Path) -> tuple[ScanRepository, Settings]:
    uploads = tmp_path / "uploads"
    uploads.mkdir()
    db_file = tmp_path / "test.db"
    settings = Settings(uploads_dir=uploads, db_path=db_file)
    init_db(settings=settings)
    conn = sqlite3.connect(db_file)
    conn.row_factory = sqlite3.Row
    return ScanRepository(conn, settings=settings), settings

def test_delete_all_scans_and_images(temp_repo: tuple[ScanRepository, Settings]) -> None:
    repo, settings = temp_repo
    # Create two dummy image files
    img1 = settings.uploads_dir / "00000000000000000000000000000001.jpg"
    img2 = settings.uploads_dir / "00000000000000000000000000000002.jpg"
    img1.write_bytes(b"dummy image 1")
    img2.write_bytes(b"dummy image 2")

    r1 = ScanRecord(
        id="scan_1",
        image_filename=img1.name,
        label="Tomato___Late_blight",
        resolution_stage="exact",
        display_name="Late Blight",
        crop="Tomato",
        disease="Late Blight",
        confidence=0.95,
        model_used="vit_b16",
        is_uncertain=False,
        is_healthy=False,
    )
    r2 = ScanRecord(
        id="scan_2",
        image_filename=img2.name,
        label="Apple___Apple_scab",
        resolution_stage="exact",
        display_name="Apple Scab",
        crop="Apple",
        disease="Apple Scab",
        confidence=0.91,
        model_used="vit_b16",
        is_uncertain=False,
        is_healthy=False,
    )
    repo.insert(r1)
    repo.insert(r2)

    assert repo.count() == 2
    assert img1.exists()
    assert img2.exists()

    deleted_count = repo.delete_all()
    assert deleted_count == 2
    assert repo.count() == 0
    assert not img1.exists()
    assert not img2.exists()

def test_delete_all_history_endpoint(tmp_path: Path) -> None:
    uploads = tmp_path / "uploads"
    uploads.mkdir()
    db_file = tmp_path / "test.db"
    settings = Settings(uploads_dir=uploads, db_path=db_file)
    init_db(settings=settings)

    img = uploads / "00000000000000000000000000000003.jpg"
    img.write_bytes(b"dummy")

    conn = sqlite3.connect(db_file)
    conn.row_factory = sqlite3.Row
    repo = ScanRepository(conn, settings=settings)
    repo.insert(
        ScanRecord(
            id="scan_test",
            image_filename=img.name,
            label="Tomato___healthy",
            resolution_stage="exact",
            display_name="Healthy",
            crop="Tomato",
            disease="Healthy",
            confidence=0.99,
            model_used="vit_b16",
            is_uncertain=False,
            is_healthy=True,
        )
    )
    conn.close()

    from app.dependencies import get_app_settings

    app = create_app(settings=settings)
    app.dependency_overrides[get_app_settings] = lambda: settings
    with TestClient(app) as client:
        # Check scan exists
        res = client.get("/api/history")
        assert res.status_code == 200
        assert res.json()["total"] == 1

        # Call delete all
        del_res = client.delete("/api/history")
        assert del_res.status_code == 204

        # Verify history is now empty
        res_after = client.get("/api/history")
        assert res_after.status_code == 200
        assert res_after.json()["total"] == 0
        assert len(res_after.json()["items"]) == 0
        assert not img.exists()
