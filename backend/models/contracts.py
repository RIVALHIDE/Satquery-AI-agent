"""Validated request, asset, trace, and response contracts for v2."""

from __future__ import annotations

import calendar
from datetime import date
from typing import Any, Annotated, Literal

import numpy as np
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


class InputConfig(BaseModel):
    """User request accepted by the backend controller."""

    bbox: Annotated[list[float], Field(min_length=4, max_length=4)]
    query: str = Field(min_length=1)
    start_date: str
    end_date: str
    satellite: Literal["auto", "sentinel-2", "sentinel-1-rtc"] = "auto"

    @field_validator("bbox")
    @classmethod
    def validate_bbox(cls, value: list[float]) -> list[float]:
        west, south, east, north = value
        if not -180 <= west <= 180 or not -180 <= east <= 180:
            raise ValueError("bbox longitude values must be between -180 and 180")
        if not -90 <= south <= 90 or not -90 <= north <= 90:
            raise ValueError("bbox latitude values must be between -90 and 90")
        if west >= east or south >= north:
            raise ValueError("bbox must be [west, south, east, north] with non-zero area")
        return [float(coordinate) for coordinate in value]

    @field_validator("start_date", "end_date")
    @classmethod
    def validate_date(cls, value: str) -> str:
        if len(value) == 10:
            try:
                date.fromisoformat(value)
            except ValueError as exc:
                raise ValueError("dates must use YYYY-MM or YYYY-MM-DD format") from exc
            return value
        if len(value) != 7 or value[4] != "-":
            raise ValueError("dates must use YYYY-MM or YYYY-MM-DD format")
        try:
            year, month = (int(part) for part in value.split("-"))
            if year < 1 or not 1 <= month <= 12:
                raise ValueError
        except ValueError as exc:
            raise ValueError("dates must use YYYY-MM or YYYY-MM-DD format") from exc
        return value

    @model_validator(mode="after")
    def validate_range(self) -> "InputConfig":
        def comparable(value: str, start: bool) -> date:
            if len(value) == 7:
                year, month = (int(part) for part in value.split("-"))
                return date(year, month, 1 if start else calendar.monthrange(year, month)[1])
            return date.fromisoformat(value)

        if comparable(self.start_date, True) > comparable(self.end_date, False):
            raise ValueError("start_date must be on or before end_date")
        return self

    def bbox_tuple(self) -> tuple[float, float, float, float]:
        return tuple(self.bbox)  # type: ignore[return-value]


class Asset(BaseModel):
    """A validated scene with analysis-ready raster bands."""

    model_config = ConfigDict(arbitrary_types_allowed=True)

    source: str
    scene_id: str
    acquisition_date: date
    cloud_cover: float
    bbox: tuple[float, float, float, float]
    crs: str
    bands: dict[str, np.ndarray]
    mode: Literal["optical", "sar"] = "optical"
    properties: dict[str, Any] = Field(default_factory=dict)

    @property
    def month(self) -> str:
        return self.acquisition_date.strftime("%Y-%m")


class TraceStep(BaseModel):
    """One auditable controller or mathematical tool execution."""

    tool_name: str
    duration_ms: float = Field(ge=0)
    params: dict[str, Any] = Field(default_factory=dict)
    output: dict[str, Any] = Field(default_factory=dict)
    status: Literal["ok", "error"] = "ok"


class MonthlyResult(BaseModel):
    """Per-scene metrics returned to the map report."""

    date: str
    scene_id: str
    cloud_cover: float
    metrics: dict[str, float]
    change_from_previous: dict[str, float] | None = None
    summary: str
    thumbnail_b64: str | None = None


class AnalysisResult(BaseModel):
    """Stable API response consumed by the React War Room and report."""

    status: Literal["ok", "error"]
    query: str
    bbox: list[float]
    confidence: float = Field(ge=0, le=1)
    metrics: dict[str, float] = Field(default_factory=dict)
    trace: list[TraceStep] = Field(default_factory=list)
    answer: str = ""
    summary: str = ""
    months: list[MonthlyResult] = Field(default_factory=list)
    error: str | None = None

    @model_validator(mode="after")
    def keep_answer_and_summary_aligned(self) -> "AnalysisResult":
        if not self.answer and self.summary:
            self.answer = self.summary
        if not self.summary and self.answer:
            self.summary = self.answer
        return self
