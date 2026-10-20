"""Physical optical indices and coverage metrics."""

from __future__ import annotations

from typing import Any

import numpy as np


def _band(value: Any, name: str, shape: tuple[int, int] | None = None) -> np.ndarray:
    values = np.nan_to_num(
        np.asarray(value, dtype=np.float32),
        nan=0.0,
        posinf=0.0,
        neginf=0.0,
    )
    if values.ndim != 2 or values.size == 0:
        raise ValueError(f"{name} must be a non-empty two-dimensional band")
    if shape is not None and values.shape != shape:
        raise ValueError(f"{name} must have the same dimensions as the other bands")
    return values


def _normalized_difference(first: np.ndarray, second: np.ndarray) -> np.ndarray:
    denominator = first + second
    with np.errstate(divide="ignore", invalid="ignore"):
        result = np.divide(
            first - second,
            denominator,
            out=np.zeros_like(first, dtype=np.float32),
            where=denominator != 0,
        )
    return np.nan_to_num(result, nan=0.0, posinf=0.0, neginf=0.0)


def compute_ndvi(nir: Any, red: Any) -> np.ndarray:
    """Compute NDVI=(NIR-red)/(NIR+red) with finite output."""

    nir_band = _band(nir, "nir")
    return _normalized_difference(nir_band, _band(red, "red", nir_band.shape))


def compute_ndwi(green: Any, nir: Any) -> np.ndarray:
    """Compute NDWI=(green-NIR)/(green+NIR) with finite output."""

    green_band = _band(green, "green")
    return _normalized_difference(green_band, _band(nir, "nir", green_band.shape))


def calculate_indices(
    *,
    nir: Any,
    red: Any,
    green: Any | None = None,
    vegetation_threshold: float = 0.2,
    water_threshold: float = 0.0,
) -> dict[str, float]:
    """Return exact NDVI/NDWI means and thresholded pixel percentages."""

    ndvi = compute_ndvi(nir, red)
    metrics: dict[str, float] = {
        "ndvi_mean": float(np.mean(ndvi)),
        "ndvi_vegetation_percentage": float(
            np.count_nonzero(ndvi > vegetation_threshold) / ndvi.size * 100
        ),
    }
    if green is not None:
        ndwi = compute_ndwi(green, nir)
        metrics.update(
            ndwi_mean=float(np.mean(ndwi)),
            ndwi_water_percentage=float(
                np.count_nonzero(ndwi > water_threshold) / ndwi.size * 100
            ),
        )
    return {key: round(value, 6) for key, value in metrics.items()}
