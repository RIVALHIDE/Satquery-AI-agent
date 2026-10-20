"""Deterministic Classifier -> Planner -> Executor -> Integrator -> Composer."""

from __future__ import annotations

import re
import time
from base64 import b64encode
from io import BytesIO
from typing import Any, Callable

import cv2
import numpy as np
from PIL import Image

from backend.acquisition.errors import AcquisitionError
from backend.acquisition.stac_search import AcquisitionPipeline
from backend.models.contracts import AnalysisResult, Asset, InputConfig, MonthlyResult, TraceStep
from backend.tools.change.index import detect_change
from backend.tools.geo.area import calculate_geodesic_area
from backend.tools.geo.indices import calculate_indices
from backend.tools.registry import ToolRegistry

from .planner import DAGPlanner
from .validator import SceneValidator


def _display_band(band: np.ndarray, shape: tuple[int, int]) -> np.ndarray:
    values = np.nan_to_num(np.asarray(band, dtype=np.float32), nan=0.0, posinf=0.0, neginf=0.0)
    if values.shape != shape:
        values = cv2.resize(values, (shape[1], shape[0]), interpolation=cv2.INTER_LINEAR)
    finite = values[np.isfinite(values)]
    if finite.size == 0:
        return np.zeros(shape, dtype=np.uint8)
    low, high = np.percentile(finite, (2, 98))
    if high <= low:
        high = low + 1.0
    return np.clip((values - low) * 255.0 / (high - low), 0, 255).astype(np.uint8)


def _scene_image(scene: Asset) -> np.ndarray:
    """Create a display image without changing physical analysis bands."""

    if scene.mode == "optical":
        red = scene.bands.get("red")
        if red is None:
            raise ValueError(f"scene {scene.scene_id} has no red band")
        shape = np.asarray(red).shape
        green = scene.bands.get("green", red)
        blue = scene.bands.get("blue", red)
        return np.dstack(
            (_display_band(blue, shape), _display_band(green, shape), _display_band(red, shape))
        ).astype(np.uint8)
    vv = scene.bands.get("vv")
    if vv is None:
        vv = scene.bands.get("vh")
    if vv is None:
        raise ValueError(f"scene {scene.scene_id} has no SAR band")
    grayscale = _display_band(vv, np.asarray(vv).shape)
    return np.dstack((grayscale, grayscale, grayscale)).astype(np.uint8)


def _thumbnail(image: np.ndarray) -> str:
    buffer = BytesIO()
    Image.fromarray(image).save(buffer, format="PNG")
    return b64encode(buffer.getvalue()).decode("ascii")


def _jsonable(value: Any) -> Any:
    if isinstance(value, dict):
        return {str(key): _jsonable(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_jsonable(item) for item in value]
    if isinstance(value, (np.integer, np.floating)):
        return value.item()
    if isinstance(value, np.ndarray):
        return {"shape": list(value.shape), "dtype": str(value.dtype)}
    return value


def _numeric(values: dict[str, Any]) -> dict[str, float]:
    return {
        key: float(value)
        for key, value in values.items()
        if isinstance(value, (int, float, np.integer, np.floating))
        and not isinstance(value, bool)
        and np.isfinite(value)
    }


class QueryClassifier:
    """Classify the requested evidence without invoking a hosted model."""

    _change_terms = re.compile(r"\b(change|changed|compare|difference|temporal|before|after|monitor|detect)\b", re.I)
    _feature_terms = re.compile(r"\b(vegetation|water|land cover|coverage|ndvi|ndwi|feature)\b", re.I)

    def classify(self, query: str) -> dict[str, bool]:
        return {
            "change_detection": bool(self._change_terms.search(query)),
            "feature_indices": bool(self._feature_terms.search(query)),
        }


class AnalysisController:
    """Execute validated tools and return a trace-backed analysis result."""

    def __init__(
        self,
        *,
        acquisition: AcquisitionPipeline | Any | None = None,
        validator: SceneValidator | None = None,
        planner: DAGPlanner | None = None,
        registry: ToolRegistry | None = None,
        classifier: QueryClassifier | None = None,
        composer: Callable[[dict[str, float]], str] | None = None,
    ) -> None:
        self.acquisition = acquisition or AcquisitionPipeline()
        self.validator = validator or SceneValidator()
        self.planner = planner or DAGPlanner()
        self.classifier = classifier or QueryClassifier()
        self.registry = registry or ToolRegistry()
        self.registry.register("geo.area", calculate_geodesic_area, "WGS84 geodesic area")
        self.registry.register("geo.indices", calculate_indices, "NDVI and NDWI")
        self.registry.register("change.detect", detect_change, "SSIM and Otsu change")
        self.composer = composer or self._default_composer

    @staticmethod
    def _default_composer(metrics: dict[str, float]) -> str:
        area = metrics.get("area_hectares", 0.0)
        vegetation = metrics.get("vegetation_coverage_percentage", 0.0)
        water = metrics.get("water_coverage_percentage", 0.0)
        changed = metrics.get("changed_area_percentage", 0.0)
        scenes = int(metrics.get("scene_count", 0.0))
        return (
            f"Analyzed {scenes} validated scene(s) covering {area:.2f} hectares. "
            f"Mean vegetation coverage is {vegetation:.2f}% and water coverage is "
            f"{water:.2f}%. Mean detected change is {changed:.2f}%."
        )

    def _step(
        self,
        trace: list[TraceStep],
        name: str,
        params: dict[str, Any],
        function: Callable[[], Any],
        summary: Callable[[Any], dict[str, Any]] | None = None,
    ) -> Any:
        started = time.perf_counter()
        try:
            output = function()
        except Exception as exc:
            trace.append(
                TraceStep(
                    tool_name=name,
                    params=_jsonable(params),
                    duration_ms=round((time.perf_counter() - started) * 1000, 3),
                    output={"error": str(exc)},
                    status="error",
                )
            )
            raise
        trace.append(
            TraceStep(
                tool_name=name,
                params=_jsonable(params),
                duration_ms=round((time.perf_counter() - started) * 1000, 3),
                output=_jsonable(summary(output) if summary else output),
            )
        )
        return output

    def analyze(self, query: InputConfig) -> AnalysisResult:
        trace: list[TraceStep] = []
        try:
            classification = self._step(
                trace,
                "agent.classifier",
                {"query": query.query},
                lambda: self.classifier.classify(query.query),
            )
            scenes = self._step(
                trace,
                "acquisition.fetch",
                {"bbox": query.bbox, "start_date": query.start_date, "end_date": query.end_date, "satellite": query.satellite},
                lambda: self.acquisition.fetch(query),
                lambda result: {"scene_count": len(result), "scene_ids": [scene.scene_id for scene in result]},
            )
            if not scenes:
                raise AcquisitionError("No satellite scenes were available for the selected request")
            self._step(
                trace,
                "validator.assets",
                {"scene_ids": [scene.scene_id for scene in scenes]},
                lambda: [self.validator.validate_scene(scene) for scene in scenes],
                lambda result: {"validated_scene_count": len(result)},
            )
            plan = self._step(
                trace,
                "agent.planner",
                {"classification": classification, "scene_count": len(scenes)},
                lambda: self.planner.plan(query, scenes),
                lambda result: {"nodes": [node.name for node in result.nodes]},
            )
            del plan
            area = self._step(
                trace,
                "geo.area",
                {"bbox": query.bbox},
                lambda: self.registry.execute("geo.area", bbox=query.bbox),
            )

            ordered = sorted(scenes, key=lambda value: value.acquisition_date)
            monthly: list[MonthlyResult] = []
            images: list[np.ndarray] = []
            per_scene: list[dict[str, float]] = []
            for scene in ordered:
                image = self._step(
                    trace,
                    "thumbnail.prepare",
                    {"scene_id": scene.scene_id, "mode": scene.mode},
                    lambda scene=scene: _scene_image(scene),
                    lambda result: {"width": int(result.shape[1]), "height": int(result.shape[0])},
                )
                images.append(image)
                if scene.mode == "optical":
                    index_metrics = self._step(
                        trace,
                        "geo.indices",
                        {"scene_id": scene.scene_id, "mode": scene.mode},
                        lambda scene=scene: self.registry.execute(
                            "geo.indices",
                            nir=scene.bands["nir"],
                            red=scene.bands["red"],
                            green=scene.bands.get("green"),
                        ),
                    )
                else:
                    index_metrics = self._step(
                        trace,
                        "sar.backscatter",
                        {"scene_id": scene.scene_id, "mode": scene.mode},
                        lambda scene=scene: self._sar_metrics(scene),
                    )
                metrics = _numeric({**area, **index_metrics, "cloud_cover": scene.cloud_cover})
                per_scene.append(metrics)
                monthly.append(
                    MonthlyResult(
                        date=scene.month,
                        scene_id=scene.scene_id,
                        cloud_cover=float(scene.cloud_cover),
                        metrics=metrics,
                        summary=f"Validated {scene.mode} scene {scene.scene_id}.",
                        thumbnail_b64=_thumbnail(image),
                    )
                )

            for index in range(1, len(ordered)):
                first, second = ordered[index - 1], ordered[index]
                validation = self._step(
                    trace,
                    "validator.scene_pair",
                    {"before": first.scene_id, "after": second.scene_id},
                    lambda first=first, second=second: self.validator.validate_pair(first, second),
                    lambda result: {"overlap_ratio": result.overlap_ratio, "message": result.message},
                )
                del validation
                before, after = images[index - 1], images[index]
                if before.shape != after.shape:
                    after = cv2.resize(after, (before.shape[1], before.shape[0]), interpolation=cv2.INTER_LINEAR)
                change = self._step(
                    trace,
                    "change.detect",
                    {"before": first.scene_id, "after": second.scene_id},
                    lambda before=before, after=after: self.registry.execute(
                        "change.detect", before=before, after=after
                    ),
                )
                change_metrics = _numeric(change)
                monthly[index].change_from_previous = change_metrics
                monthly[index].metrics.update(change_metrics)
                monthly[index].summary += f" {change_metrics['changed_area_percentage']:.2f}% changed from the previous scene."

            aggregate = self._step(
                trace,
                "metrics.integrate",
                {"scene_count": len(per_scene)},
                lambda: self._integrate(area, per_scene, monthly),
            )
            answer = self._step(
                trace,
                "answer.compose",
                {"metric_keys": sorted(aggregate)},
                lambda: self.composer(dict(aggregate)),
                lambda result: {"answer": str(result)},
            )
            confidence = self._confidence(ordered)
            return AnalysisResult(
                status="ok",
                query=query.query,
                bbox=query.bbox,
                confidence=confidence,
                metrics=aggregate,
                trace=trace,
                answer=str(answer),
                summary=str(answer),
                months=monthly,
            )
        except Exception as exc:
            return AnalysisResult(
                status="error",
                query=query.query,
                bbox=query.bbox,
                confidence=0.0,
                trace=trace,
                error=str(exc),
            )

    @staticmethod
    def _sar_metrics(scene: Asset) -> dict[str, float]:
        vv = scene.bands.get("vv")
        vh = scene.bands.get("vh")
        if vv is None:
            raise ValueError(f"scene {scene.scene_id} has no VV band")
        return {
            "sar_vv_mean": round(float(np.mean(np.nan_to_num(vv))), 6),
            "sar_vh_mean": round(float(np.mean(np.nan_to_num(vh))), 6) if vh is not None else 0.0,
        }

    @staticmethod
    def _integrate(
        area: dict[str, float],
        per_scene: list[dict[str, float]],
        monthly: list[MonthlyResult],
    ) -> dict[str, float]:
        result = dict(area)
        result["scene_count"] = float(len(per_scene))
        result["optical_scene_count"] = float(sum("ndvi_mean" in scene for scene in per_scene))
        result["sar_scene_count"] = float(len(per_scene) - result["optical_scene_count"])
        for key in ("ndvi_mean", "ndvi_vegetation_percentage", "ndwi_mean", "ndwi_water_percentage", "cloud_cover", "sar_vv_mean", "sar_vh_mean"):
            values = [scene[key] for scene in per_scene if key in scene]
            if values:
                result[key] = round(float(np.mean(values)), 6)
        changed = [month.metrics["changed_area_percentage"] for month in monthly if "changed_area_percentage" in month.metrics]
        if changed:
            result["changed_area_percentage"] = round(float(np.mean(changed)), 6)
        result["vegetation_coverage_percentage"] = result.get("ndvi_vegetation_percentage", 0.0)
        result["water_coverage_percentage"] = result.get("ndwi_water_percentage", 0.0)
        return _numeric(result)

    @staticmethod
    def _confidence(scenes: list[Asset]) -> float:
        if not scenes:
            return 0.0
        optical = [max(0.0, min(100.0, scene.cloud_cover)) for scene in scenes if scene.mode == "optical"]
        cloud_factor = 1.0 - (float(np.mean(optical)) / 100.0) if optical else 1.0
        return round(max(0.0, min(1.0, cloud_factor)), 6)
