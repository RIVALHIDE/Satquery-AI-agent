"""Structural change detection using SSIM and Otsu thresholding."""

from __future__ import annotations

from typing import Any

import cv2
import numpy as np
from skimage.filters import threshold_otsu
from skimage.metrics import structural_similarity


def _gray(image: Any, name: str) -> np.ndarray:
    values = np.nan_to_num(np.asarray(image), nan=0.0, posinf=0.0, neginf=0.0)
    if values.ndim == 2:
        gray = values
    elif values.ndim == 3 and values.shape[2] in {3, 4}:
        normalized = np.clip(values, 0, 255).astype(np.uint8)
        conversion = cv2.COLOR_BGR2GRAY if values.shape[2] == 3 else cv2.COLOR_BGRA2GRAY
        gray = cv2.cvtColor(normalized, conversion)
    else:
        raise ValueError(f"{name} must be a 2-D or 3/4-channel image")
    if gray.size == 0 or gray.ndim != 2:
        raise ValueError(f"{name} cannot be empty")
    return np.clip(gray, 0, 255).astype(np.uint8)


def detect_change(before: Any, after: Any, *, min_region_area: int = 4) -> dict[str, float]:
    """Return SSIM, Otsu threshold, and changed-area metrics."""

    if min_region_area < 1:
        raise ValueError("min_region_area must be positive")
    before_gray = _gray(before, "before")
    after_gray = _gray(after, "after")
    if before_gray.shape != after_gray.shape:
        raise ValueError("before and after images must have the same dimensions")
    minimum_dimension = min(before_gray.shape)
    if minimum_dimension < 3:
        raise ValueError("change detection requires images at least 3 pixels wide and tall")
    window = min(7, minimum_dimension)
    if window % 2 == 0:
        window -= 1
    score, similarity = structural_similarity(
        before_gray,
        after_gray,
        data_range=255,
        full=True,
        win_size=window,
    )
    difference = np.clip((1.0 - similarity) * 255.0, 0, 255).astype(np.uint8)
    otsu = float(threshold_otsu(difference)) if np.any(difference) else 0.0
    mask = (difference > otsu).astype(np.uint8) * 255
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    regions = sum(1 for contour in contours if cv2.contourArea(contour) >= min_region_area)
    changed_pixels = int(np.count_nonzero(mask))
    return {
        "changed_area_percentage": round(changed_pixels / mask.size * 100, 6),
        "changed_pixels": float(changed_pixels),
        "region_count": float(regions),
        "ssim_score": round(float(score), 6),
        "otsu_threshold": round(otsu, 6),
    }
