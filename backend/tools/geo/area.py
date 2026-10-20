"""Geodesic area calculation for WGS84 bounding boxes."""

from __future__ import annotations

from typing import Iterable

from shapely.geometry import box

try:
    from pyproj import Geod
except ImportError:  # pragma: no cover - pinned production dependency.
    Geod = None  # type: ignore[assignment,misc]


def calculate_geodesic_area(bbox: Iterable[float]) -> dict[str, float]:
    """Return exact WGS84 area in square kilometres and hectares."""

    west, south, east, north = (float(value) for value in bbox)
    if not -180 <= west < east <= 180 or not -90 <= south < north <= 90:
        raise ValueError("bbox must be [west, south, east, north] within WGS84")
    polygon = box(west, south, east, north)
    if Geod is not None:
        square_meters, _ = Geod(ellps="WGS84").geometry_area_perimeter(polygon)
        square_meters = abs(float(square_meters))
    else:  # deterministic fallback for minimal installations.
        import math

        radius = 6_378_137.0
        square_meters = abs(
            radius**2
            * (math.radians(east) - math.radians(west))
            * (math.sin(math.radians(north)) - math.sin(math.radians(south)))
        )
    return {
        "area_km2": round(square_meters / 1_000_000, 6),
        "area_hectares": round(square_meters / 10_000, 6),
    }
