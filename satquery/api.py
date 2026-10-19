"""FastAPI HTTP surface for the offline satellite query agent."""

from __future__ import annotations

from fastapi import FastAPI, File, Form, HTTPException, UploadFile

from .models import AgentResponse
from .router import OrchestratorRouterAgent
from .service import analyze_query

app = FastAPI(
    title="SatQuery-Agent",
    description="Offline-first agentic satellite image analysis.",
    version="0.1.0",
)
agent = OrchestratorRouterAgent()


@app.get("/health")
def health() -> dict[str, str]:
    """Return a local health response without checking external services."""

    return {"status": "ok", "mode": "offline"}


@app.post("/query", response_model=AgentResponse)
async def query(
    query_text: str = Form(..., description="Natural-language satellite query"),
    image_before: UploadFile | None = File(
        default=None, description="Earlier image for change detection"
    ),
    image_after: UploadFile | None = File(
        default=None, description="Later image for change detection"
    ),
    image: UploadFile | None = File(
        default=None, description="Single image for feature extraction"
    ),
) -> AgentResponse:
    """Route a text query and optionally analyze one or two uploaded images."""

    try:
        before_bytes = await image_before.read() if image_before else None
        after_bytes = await image_after.read() if image_after else None
        image_bytes = await image.read() if image else None
        return analyze_query(
            query_text,
            before_bytes=before_bytes,
            after_bytes=after_bytes,
            image_bytes=image_bytes,
            agent=agent,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
