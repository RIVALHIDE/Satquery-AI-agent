"""Deterministic OpenCV specialist tools used by the router."""

from __future__ import annotations

from typing import Final

import cv2
import numpy as np

from .models import BoundingBox, ToolResult


_CHANNEL_COUNT: Final = 3


def _as_bgr(image: np.ndarray, name: str) -> np.ndarray:
    """Validate an image array and normalize it to an 8-bit BGR array."""

    if not isinstance(image, np.ndarray):
        raise ValueError(f"{name} must be a NumPy array")
    if image.size == 0:
        raise ValueError(f"{name} cannot be empty")
    if image.ndim == 2:
        image = cv2.cvtColor(image, cv2.COLOR_GRAY2BGR)
    elif image.ndim == 3 and image.shape[2] == 4:
        image = cv2.cvtColor(image, cv2.COLOR_BGRA2BGR)
    elif image.ndim != 3 or image.shape[2] != _CHANNEL_COUNT:
        raise ValueError(f"{name} must have one, three, or four channels")

    if image.dtype != np.uint8:
        image = np.clip(image, 0, 255).astype(np.uint8)
    return image


class BiTemporalChangeDetectionTool:
    """Find changed pixel regions between two same-sized images."""

    name = "bi_temporal_change_detection"

    def __init__(self, threshold: int = 25, min_region_area: int = 4) -> None:
        if not 0 <= threshold <= 255:
            raise ValueError("threshold must be between 0 and 255")
        if min_region_area < 1:
            raise ValueError("min_region_area must be positive")
        self.threshold = threshold
        self.min_region_area = min_region_area

    def analyze(self, before: np.ndarray, after: np.ndarray) -> ToolResult:
        before_bgr = _as_bgr(before, "before image")
        after_bgr = _as_bgr(after, "after image")
        if before_bgr.shape != after_bgr.shape:
            raise ValueError("before and after images must have the same dimensions")

        before_gray = cv2.cvtColor(before_bgr, cv2.COLOR_BGR2GRAY)
        after_gray = cv2.cvtColor(after_bgr, cv2.COLOR_BGR2GRAY)
        difference = cv2.absdiff(before_gray, after_gray)
        _, mask = cv2.threshold(
            difference, self.threshold, 255, cv2.THRESH_BINARY
        )

        contours, _ = cv2.findContours(
            mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE
        )
        boxes: list[BoundingBox] = []
        for contour in contours:
            x, y, width, height = cv2.boundingRect(contour)
            if width * height < self.min_region_area:
                continue
            boxes.append(
                BoundingBox(
                    x=x,
                    y=y,
                    width=width,
                    height=height,
                    area=width * height,
                )
            )
        boxes.sort(key=lambda box: (box.y, box.x))

        height, width = difference.shape
        changed_pixels = int(cv2.countNonZero(mask))
        total_pixels = height * width
        changed_percentage = (changed_pixels / total_pixels) * 100
        summary = (
            f"Detected {changed_percentage:.2f}% structural surface shift "
            f"across {len(boxes)} changed region(s)."
        )
        return ToolResult(
            tool=self.name,
            summary=summary,
            metrics={
                "changed_area_percentage": round(changed_percentage, 4),
                "changed_pixels": changed_pixels,
                "region_count": len(boxes),
                "threshold": self.threshold,
            },
            bounding_boxes=boxes,
            details={"width": width, "height": height},
        )


class FeatureExtractionTool:
    """Estimate water and vegetation coverage using HSV color thresholds."""

    name = "feature_extraction"

    def analyze(self, image: np.ndarray) -> ToolResult:
        bgr = _as_bgr(image, "image")
        hsv = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV)
        height, width = hsv.shape[:2]
        total_pixels = height * width

        # OpenCV hue is 0..179. Blue/cyan is water; green is vegetation.
        water_mask = cv2.inRange(
            hsv,
            np.array([90, 50, 30], dtype=np.uint8),
            np.array([135, 255, 255], dtype=np.uint8),
        )
        vegetation_mask = cv2.inRange(
            hsv,
            np.array([35, 50, 30], dtype=np.uint8),
            np.array([89, 255, 255], dtype=np.uint8),
        )
        water_pixels = int(cv2.countNonZero(water_mask))
        vegetation_pixels = int(cv2.countNonZero(vegetation_mask))
        water_percentage = (water_pixels / total_pixels) * 100
        vegetation_percentage = (vegetation_pixels / total_pixels) * 100

        summary = (
            f"Water bodies cover {water_percentage:.2f}% and vegetation covers "
            f"{vegetation_percentage:.2f}% of the image."
        )
        return ToolResult(
            tool=self.name,
            summary=summary,
            metrics={
                "water_coverage_percentage": round(water_percentage, 4),
                "vegetation_coverage_percentage": round(vegetation_percentage, 4),
                "water_pixels": water_pixels,
                "vegetation_pixels": vegetation_pixels,
            },
            details={"width": width, "height": height, "color_space": "HSV"},
        )
