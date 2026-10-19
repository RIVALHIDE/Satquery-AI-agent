"""Shared domain models for routing and offline image analysis."""

from dataclasses import dataclass
from enum import Enum
from typing import Any, Literal

from pydantic import BaseModel, Field


class Intent(str, Enum):
    """Supported user intents understood by the local orchestrator."""

    CHANGE_DETECTION = "change_detection"
    FEATURE_EXTRACTION = "feature_extraction"
    UNKNOWN = "unknown"


@dataclass(frozen=True)
class RouteDecision:
    """Stable routing decision produced before a specialist tool runs."""

    intent: Intent
    tool_name: str | None
    reason: str


class BoundingBox(BaseModel):
    """Pixel-space bounding box around one detected changed region."""

    x: int = Field(ge=0)
    y: int = Field(ge=0)
    width: int = Field(gt=0)
    height: int = Field(gt=0)
    area: int = Field(gt=0)


class ToolResult(BaseModel):
    """Structured, UI-friendly output from one specialist tool."""

    tool: str
    summary: str
    metrics: dict[str, float | int]
    bounding_boxes: list[BoundingBox] = Field(default_factory=list)
    details: dict[str, Any] = Field(default_factory=dict)


class AgentResponse(BaseModel):
    """Public response shared by the FastAPI endpoint and Streamlit demo."""

    status: Literal["ok", "error"]
    query: str
    intent: Intent
    route: str
    route_reason: str
    result: ToolResult | None = None
    error: str | None = None
