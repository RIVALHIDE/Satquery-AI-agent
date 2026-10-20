"""Pre-flight raster, CRS, extent, overlap, and nodata validation."""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from backend.models.contracts import Asset

from backend.acquisition.errors import AssetValidationError


@dataclass(frozen=True)
class SceneValidation:
    scene_id: str
    valid: bool
    overlap_ratio: float = 1.0
    message: str = "scene is valid"


def _overlap_ratio(first: Asset, second: Asset) -> float:
    west = max(first.bbox[0], second.bbox[0])
    south = max(first.bbox[1], second.bbox[1])
    east = min(first.bbox[2], second.bbox[2])
    north = min(first.bbox[3], second.bbox[3])
    intersection = max(0.0, east - west) * max(0.0, north - south)
    first_area = max(0.0, first.bbox[2] - first.bbox[0]) * max(0.0, first.bbox[3] - first.bbox[1])
    return intersection / first_area if first_area else 0.0


class SceneValidator:
    """Reject malformed assets before mathematical tools execute."""

    def validate_scene(self, scene: Asset) -> SceneValidation:
        if not scene.crs or not str(scene.crs).strip():
            raise AssetValidationError(f"scene {scene.scene_id} has no CRS")
        if len(scene.bbox) != 4 or scene.bbox[0] >= scene.bbox[2] or scene.bbox[1] >= scene.bbox[3]:
            raise AssetValidationError(f"scene {scene.scene_id} has an invalid extent")
        if not scene.bands:
            raise AssetValidationError(f"scene {scene.scene_id} has no raster bands")
        shapes: set[tuple[int, int]] = set()
        for name, band in scene.bands.items():
            values = np.asarray(band)
            if values.ndim != 2 or values.size == 0:
                raise AssetValidationError(f"scene {scene.scene_id} band {name} is not a 2-D raster")
            if not np.isfinite(values).any():
                raise AssetValidationError(f"scene {scene.scene_id} band {name} contains no finite pixels")
            shapes.add(values.shape)
        if len(shapes) > 1:
            raise AssetValidationError(f"scene {scene.scene_id} bands have incompatible dimensions")
        return SceneValidation(scene_id=scene.scene_id, valid=True)

    def validate_pair(self, first: Asset, second: Asset) -> SceneValidation:
        if not first.crs or not second.crs or str(first.crs) != str(second.crs):
            raise AssetValidationError(
                f"scene pair has incompatible CRS: {first.crs!r} and {second.crs!r}"
            )
        overlap = _overlap_ratio(first, second)
        if overlap <= 0:
            raise AssetValidationError(
                f"scene pair {first.scene_id}/{second.scene_id} has 0% geographic overlap"
            )
        return SceneValidation(
            scene_id=f"{first.scene_id}->{second.scene_id}",
            valid=True,
            overlap_ratio=overlap,
            message=f"pair overlap {overlap * 100:.2f}%",
        )
