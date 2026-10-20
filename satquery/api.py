"""Compatibility import for deployments that still target ``satquery.api``."""

from backend.api import analyze, app, controller, health, imagery_analyze

__all__ = ["analyze", "app", "controller", "health", "imagery_analyze"]
