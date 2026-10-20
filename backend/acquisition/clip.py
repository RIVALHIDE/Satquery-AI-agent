"""Safe raster reading and proportional bbox clipping primitives."""

from __future__ import annotations

from typing import Any, Iterable

import numpy as np

from .errors import AcquisitionError

try:
    import rasterio
    from rasterio.enums import Resampling
except ImportError:  # pragma: no cover - pinned production dependency.
    rasterio = None  # type: ignore[assignment]
    Resampling = None  # type: ignore[assignment,misc]


def sanitize_band(band: Any, *, dtype: np.dtype | type = np.float32) -> np.ndarray:
    """Remove masks and non-finite values before any integer conversion."""

    if hasattr(band, "filled"):
        band = band.filled(0)
    values = np.nan_to_num(
        np.asarray(band, dtype=np.float32),
        nan=0.0,
        posinf=0.0,
        neginf=0.0,
    )
    target = np.dtype(dtype)
    if np.issubdtype(target, np.integer):
        info = np.iinfo(target)
        values = np.clip(values, info.min, info.max)
    return values.astype(target, copy=False)


def safe_read_raster(
    href: str,
    *,
    max_size: int = 512,
    dtype: np.dtype | type = np.float32,
) -> np.ndarray:
    """Read one band, downsample it, and preserve analysis values as floats."""

    if rasterio is None or Resampling is None:
        raise AcquisitionError("rasterio is unavailable; install pinned dependencies")
    if not href:
        raise AcquisitionError("raster asset did not include an href")
    if max_size < 1:
        raise ValueError("max_size must be positive")
    try:
        with rasterio.open(href) as dataset:
            scale = min(1.0, max_size / max(dataset.width, dataset.height))
            width = max(1, round(dataset.width * scale))
            height = max(1, round(dataset.height * scale))
            raw = dataset.read(
                1,
                out_shape=(height, width),
                resampling=Resampling.bilinear,
                masked=False,
                fill_value=0,
            )
            return sanitize_band(raw, dtype=dtype)
    except AcquisitionError:
        raise
    except Exception as exc:
        raise AcquisitionError(f"satellite raster request failed: {exc}") from exc


def clip_array_to_bbox(
    array: np.ndarray,
    source_bbox: Iterable[float],
    target_bbox: Iterable[float],
) -> np.ndarray:
    """Clip a north-up array using source/target WGS84 bbox proportions."""

    values = sanitize_band(array, dtype=np.float32)
    west, south, east, north = (float(value) for value in source_bbox)
    clip_west, clip_south, clip_east, clip_north = (float(value) for value in target_bbox)
    if not west < east or not south < north:
        raise AcquisitionError("source bbox must have positive area")
    left = max(west, clip_west)
    right = min(east, clip_east)
    bottom = max(south, clip_south)
    top = min(north, clip_north)
    if left >= right or bottom >= top:
        raise AcquisitionError("target bbox does not overlap the raster extent")
    height, width = values.shape[-2:]
    x0 = max(0, int(np.floor((left - west) / (east - west) * width)))
    x1 = min(width, int(np.ceil((right - west) / (east - west) * width)))
    y0 = max(0, int(np.floor((north - top) / (north - south) * height)))
    y1 = min(height, int(np.ceil((north - bottom) / (north - south) * height)))
    if x0 >= x1 or y0 >= y1:
        raise AcquisitionError("target bbox clipped to an empty raster")
    return values[y0:y1, x0:x1]
