"""FastAPI bridge for the trace-backed SatQuery AI controller."""

from __future__ import annotations

import logging

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from backend.agent.controller import AnalysisController
from backend.models.contracts import AnalysisResult, InputConfig

LOGGER = logging.getLogger(__name__)

app = FastAPI(
    title="SatQuery AI v2",
    description="Trace-backed deterministic satellite analysis.",
    version="2.0.0",
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

controller = AnalysisController()


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "mode": "v2-backend"}


def _analyze(payload: InputConfig) -> AnalysisResult:
    try:
        return controller.analyze(payload)
    except Exception as exc:  # The controller normally returns structured errors itself.
        LOGGER.exception("Unhandled analysis failure")
        return AnalysisResult(
            status="error",
            query=payload.query,
            bbox=payload.bbox,
            confidence=0.0,
            error=str(exc),
        )


@app.post("/analyze", response_model=AnalysisResult)
def analyze(payload: InputConfig) -> AnalysisResult:
    """Run one trace-backed analysis for a bbox and date range."""

    return _analyze(payload)


@app.post("/imagery/analyze", response_model=AnalysisResult)
def imagery_analyze(payload: InputConfig) -> AnalysisResult:
    """Compatibility alias for existing frontend callers."""

    return _analyze(payload)
