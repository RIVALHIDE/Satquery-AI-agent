"""Offline orchestrator router and dependency-injected specialist swarm."""

from __future__ import annotations

import re
from typing import Protocol

import numpy as np

from .models import AgentResponse, Intent, RouteDecision, ToolResult
from .tools import BiTemporalChangeDetectionTool, FeatureExtractionTool


class IntentClassifier(Protocol):
    """Small seam that lets tests or a future local model provide intent labels."""

    def classify(self, query: str) -> Intent:
        ...


class KeywordIntentClassifier:
    """Deterministic classifier used by default so the app works fully offline."""

    _change_terms = (
        "change",
        "changed",
        "difference",
        "diff",
        "between",
        "before and after",
        "temporal",
        "compare",
        "comparison",
    )
    _feature_terms = (
        "highlight",
        "water",
        "vegetation",
        "coverage",
        "feature",
        "segment",
        "land cover",
    )

    def classify(self, query: str) -> Intent:
        normalized = re.sub(r"\s+", " ", query.strip().casefold())
        if any(term in normalized for term in self._change_terms):
            return Intent.CHANGE_DETECTION
        if any(term in normalized for term in self._feature_terms):
            return Intent.FEATURE_EXTRACTION
        return Intent.UNKNOWN


class OrchestratorRouterAgent:
    """Route a query to exactly one local specialist tool."""

    def __init__(
        self,
        classifier: IntentClassifier | None = None,
        change_tool: BiTemporalChangeDetectionTool | None = None,
        feature_tool: FeatureExtractionTool | None = None,
    ) -> None:
        self.classifier = classifier or KeywordIntentClassifier()
        self.change_tool = change_tool or BiTemporalChangeDetectionTool()
        self.feature_tool = feature_tool or FeatureExtractionTool()

    def route(self, query: str) -> RouteDecision:
        if not isinstance(query, str):
            raise ValueError("query must be text")
        intent = self.classifier.classify(query)
        if not isinstance(intent, Intent):
            intent = Intent(intent)

        if intent is Intent.CHANGE_DETECTION:
            return RouteDecision(
                intent=intent,
                tool_name=self.change_tool.name,
                reason="Temporal comparison language selected the change detection tool.",
            )
        if intent is Intent.FEATURE_EXTRACTION:
            return RouteDecision(
                intent=intent,
                tool_name=self.feature_tool.name,
                reason="Feature or coverage language selected the extraction tool.",
            )
        return RouteDecision(
            intent=Intent.UNKNOWN,
            tool_name=None,
            reason="No supported satellite-image intent was found in the query.",
        )

    def run(
        self,
        query: str,
        *,
        before: np.ndarray | None = None,
        after: np.ndarray | None = None,
        image: np.ndarray | None = None,
    ) -> AgentResponse:
        decision = self.route(query)
        if decision.intent is Intent.UNKNOWN:
            return AgentResponse(
                status="error",
                query=query,
                intent=decision.intent,
                route="unknown",
                route_reason=decision.reason,
                error=(
                    "I could not route that request. Ask about changes between "
                    "two images, or water/vegetation coverage in one image."
                ),
            )

        try:
            result: ToolResult
            if decision.intent is Intent.CHANGE_DETECTION:
                if before is None or after is None:
                    raise ValueError(
                        "change detection requires both before and after images"
                    )
                result = self.change_tool.analyze(before, after)
            else:
                if image is None:
                    raise ValueError("feature extraction requires one image")
                result = self.feature_tool.analyze(image)
        except ValueError as exc:
            return AgentResponse(
                status="error",
                query=query,
                intent=decision.intent,
                route=decision.tool_name or decision.intent.value,
                route_reason=decision.reason,
                error=str(exc),
            )

        return AgentResponse(
            status="ok",
            query=query,
            intent=decision.intent,
            route=decision.tool_name or decision.intent.value,
            route_reason=decision.reason,
            result=result,
        )
