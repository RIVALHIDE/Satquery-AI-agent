"""Application service shared by FastAPI and the local Streamlit UI."""

from __future__ import annotations

import cv2
import numpy as np

from .models import AgentResponse
from .router import OrchestratorRouterAgent


def decode_image_bytes(data: bytes, name: str = "image") -> np.ndarray:
    """Decode an uploaded raster without touching the filesystem."""

    if not data:
        raise ValueError(f"{name} cannot be empty")
    encoded = np.frombuffer(data, dtype=np.uint8)
    decoded = cv2.imdecode(encoded, cv2.IMREAD_COLOR)
    if decoded is None:
        raise ValueError(f"{name} is not a supported image file")
    return decoded


def analyze_query(
    query: str,
    *,
    before_bytes: bytes | None = None,
    after_bytes: bytes | None = None,
    image_bytes: bytes | None = None,
    agent: OrchestratorRouterAgent | None = None,
) -> AgentResponse:
    """Decode uploaded images and run the dependency-injected local agent."""

    before = (
        decode_image_bytes(before_bytes, "before image")
        if before_bytes is not None
        else None
    )
    after = (
        decode_image_bytes(after_bytes, "after image")
        if after_bytes is not None
        else None
    )
    image = decode_image_bytes(image_bytes) if image_bytes is not None else None
    return (agent or OrchestratorRouterAgent()).run(
        query, before=before, after=after, image=image
    )
