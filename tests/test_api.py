import cv2
import numpy as np
from fastapi.testclient import TestClient

from satquery.api import app


client = TestClient(app)


def _png_bytes(image):
    success, encoded = cv2.imencode(".png", image)
    assert success
    return encoded.tobytes()


def test_health_is_offline_and_local():
    response = client.get("/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok", "mode": "offline"}


def test_query_endpoint_runs_feature_tool_without_network():
    image = np.zeros((20, 20, 3), dtype=np.uint8)
    image[:, :10] = (255, 0, 0)

    response = client.post(
        "/query",
        data={"query_text": "Highlight water bodies"},
        files={"image": ("scene.png", _png_bytes(image), "image/png")},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert body["route"] == "feature_extraction"
    assert body["result"]["metrics"]["water_coverage_percentage"] == 50.0
