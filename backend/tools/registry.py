"""Explicit registry for the controller's deterministic tools."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class ToolSpec:
    """Registered tool metadata and callable implementation."""

    name: str
    function: Callable[..., Any]
    description: str = ""


class ToolRegistry:
    """Register named tools and reject accidental execution of unknown tools."""

    def __init__(self) -> None:
        self._tools: dict[str, ToolSpec] = {}

    def register(
        self,
        name: str,
        function: Callable[..., Any],
        description: str = "",
    ) -> None:
        if not name or not callable(function):
            raise ValueError("tool name and callable are required")
        if name in self._tools:
            raise ValueError(f"tool already registered: {name}")
        self._tools[name] = ToolSpec(name, function, description)

    def execute(self, name: str, **params: Any) -> Any:
        try:
            spec = self._tools[name]
        except KeyError as exc:
            raise KeyError(f"tool is not registered: {name}") from exc
        return spec.function(**params)

    def names(self) -> tuple[str, ...]:
        return tuple(sorted(self._tools))

    def specs(self) -> tuple[ToolSpec, ...]:
        return tuple(self._tools[name] for name in sorted(self._tools))
