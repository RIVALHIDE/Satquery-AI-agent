from dataclasses import dataclass
from datetime import date, datetime

import cv2
import numpy as np
from fastapi.testclient import TestClient

from backend.agent.controller import AnalysisController
from backend.acquisition.stac_search import AcquisitionPipeline, Sentinel1RTCFetcher, Sentinel2Fetcher
from backend.models.contracts import Asset, InputConfig
from backend.tools.change.index import detect_change
from backend.tools.geo.indices import calculate_indices


def _asset(scene_id: str, month: int, *, mode: str = "optical", cloud_cover: float = 5.0) -> Asset:
    if mode == "sar":
        bands = {"vv": np.full((16, 16), 0.4, dtype=np.float32)}
    else:
        red = np.full((16, 16), 0.2, dtype=np.float32)
        nir = np.full((16, 16), 0.8, dtype=np.float32)
        if month > 1:
            nir[4:8, 5:9] = 0.1
        bands = {
            "blue": np.full((16, 16), 0.1, dtype=np.float32),
            "green": np.full((16, 16), 0.3, dtype=np.float32),
            "red": red,
            "nir": nir,
        }
    return Asset(
        source="test",
        scene_id=scene_id,
        acquisition_date=date(2025, month, 15),
        cloud_cover=cloud_cover,
        bbox=(10.0, 20.0, 11.0, 21.0),
        crs="EPSG:4326",
        bands=bands,
        mode=mode,
    )


class FakeAcquisition:
    def __init__(self, scenes: list[Asset]):
        self.scenes = scenes

    def fetch(self, query: InputConfig) -> list[Asset]:
        return self.scenes


@dataclass
class FakeAsset:
    href: str


@dataclass
class FakeItem:
    id: str
    cloud_cover: float
    day: int
    mode: str

    @property
    def datetime(self) -> datetime:
        return datetime(2025, 1, self.day)

    @property
    def properties(self) -> dict[str, object]:
        return {"eo:cloud_cover": self.cloud_cover, "datetime": self.datetime}

    @property
    def assets(self) -> dict[str, FakeAsset]:
        if self.mode == "sar":
            return {"vv": FakeAsset(f"{self.id}-vv")}
        return {
            "B02": FakeAsset(f"{self.id}-blue"),
            "B03": FakeAsset(f"{self.id}-green"),
            "B04": FakeAsset(f"{self.id}-red"),
            "B08": FakeAsset(f"{self.id}-nir"),
        }


class FakeCatalog:
    def __init__(self, item: FakeItem):
        self.item = item

    def search(self, **kwargs):
        return [self.item]


def _query() -> InputConfig:
    return InputConfig(
        bbox=[10, 20, 11, 21],
        query="What changed between these dates?",
        start_date="2025-01",
        end_date="2025-02",
    )


def test_controller_returns_real_metrics_and_trace() -> None:
    response = AnalysisController(
        acquisition=FakeAcquisition([_asset("jan", 1), _asset("feb", 2)])
    ).analyze(_query())

    assert response.status == "ok"
    assert response.metrics["scene_count"] == 2
    assert response.metrics["area_hectares"] > 0
    assert response.metrics["changed_area_percentage"] >= 0
    names = [step.tool_name for step in response.trace]
    assert names[0] == "agent.classifier"
    assert "geo.indices" in names
    assert "change.detect" in names
    assert names[-1] == "answer.compose"
    assert all(step.duration_ms >= 0 for step in response.trace)
    assert all(isinstance(step.output, dict) for step in response.trace)
    assert response.answer


def test_controller_handles_sar_assets_without_array_truthiness_error() -> None:
    response = AnalysisController(
        acquisition=FakeAcquisition([_asset("sar", 1, mode="sar", cloud_cover=100)])
    ).analyze(
        InputConfig(
            bbox=[10, 20, 11, 21],
            query="Analyze radar scene",
            start_date="2025-01",
            end_date="2025-01",
            satellite="sentinel-1-rtc",
        )
    )

    assert response.status == "ok"
    assert response.metrics["sar_scene_count"] == 1
    assert response.metrics["sar_vv_mean"] == 0.4


def test_acquisition_pipeline_falls_back_to_sar_for_cloudy_optical_scene() -> None:
    reader = lambda href, **kwargs: np.ones((4, 4), dtype=np.float32)
    optical = Sentinel2Fetcher(
        catalog=FakeCatalog(FakeItem("cloudy-optical", 85.0, 15, "optical")),
        signer=lambda item: item,
        asset_reader=reader,
    )
    sar = Sentinel1RTCFetcher(
        catalog=FakeCatalog(FakeItem("clear-sar", 0.0, 16, "sar")),
        signer=lambda item: item,
        asset_reader=reader,
    )
    scenes = AcquisitionPipeline(optical=optical, sar=sar).fetch(
        InputConfig(
            bbox=[10, 20, 11, 21],
            query="Analyze cloudy area",
            start_date="2025-01",
            end_date="2025-01",
        )
    )

    assert len(scenes) == 1
    assert scenes[0].mode == "sar"
    assert scenes[0].scene_id == "clear-sar"


def test_tools_compute_expected_physical_and_change_metrics() -> None:
    assert calculate_indices(
        nir=np.full((2, 2), 0.8),
        red=np.full((2, 2), 0.2),
        green=np.full((2, 2), 0.3),
    )["ndvi_mean"] == 0.6
    before = np.zeros((32, 32), dtype=np.uint8)
    after = before.copy()
    after[10:22, 12:24] = 220
    result = detect_change(before, after)
    assert result["ssim_score"] < 1.0
    assert result["changed_area_percentage"] > 0


def test_api_returns_backend_trace_and_metrics(monkeypatch) -> None:
    import backend.api as api

    monkeypatch.setattr(
        api,
        "controller",
        AnalysisController(acquisition=FakeAcquisition([_asset("jan", 1), _asset("feb", 2)])),
    )
    response = TestClient(api.app).post(
        "/analyze",
        json={
            "bbox": [10, 20, 11, 21],
            "query": "What changed?",
            "start_date": "2025-01",
            "end_date": "2025-02",
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert body["metrics"]["scene_count"] == 2.0
    assert body["trace"][-1]["tool_name"] == "answer.compose"
    assert body["answer"]


def test_api_validation_rejects_invalid_bbox() -> None:
    from backend.api import app

    response = TestClient(app).post(
        "/analyze",
        json={
            "bbox": [10, 20, 10, 21],
            "query": "Analyze",
            "start_date": "2025-01",
            "end_date": "2025-01",
        },
    )
    assert response.status_code == 422
