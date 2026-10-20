"""Planetary Computer STAC acquisition with deterministic SAR fallback."""

from __future__ import annotations

import calendar
import logging
from datetime import date, datetime, timedelta
from typing import Any, Callable, Iterable, Mapping

import numpy as np

from backend.models.contracts import Asset, InputConfig

from .clip import safe_read_raster
from .errors import AcquisitionError, NoScenesError

try:
    import planetary_computer
except ImportError:  # pragma: no cover - optional for mocked tests.
    planetary_computer = None  # type: ignore[assignment]

try:
    import pystac_client
except ImportError:  # pragma: no cover - optional for mocked tests.
    pystac_client = None  # type: ignore[assignment]


LOGGER = logging.getLogger(__name__)
PLANETARY_COMPUTER_STAC_URL = "https://planetarycomputer.microsoft.com/api/stac/v1"


def validate_bbox(bbox: Iterable[float]) -> tuple[float, float, float, float]:
    try:
        values = tuple(float(value) for value in bbox)
    except (TypeError, ValueError) as exc:
        raise AcquisitionError("bbox must contain four numeric coordinates") from exc
    if len(values) != 4:
        raise AcquisitionError("bbox must contain exactly four coordinates")
    west, south, east, north = values
    if not -180 <= west <= 180 or not -180 <= east <= 180:
        raise AcquisitionError("bbox longitude values must be between -180 and 180")
    if not -90 <= south <= 90 or not -90 <= north <= 90:
        raise AcquisitionError("bbox latitude values must be between -90 and 90")
    if west >= east or south >= north:
        raise AcquisitionError("bbox must be [west, south, east, north] with non-zero area")
    return west, south, east, north


def _parse_date(value: date | str, start: bool) -> date:
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    if isinstance(value, str) and len(value) == 7:
        try:
            year, month = (int(part) for part in value.split("-"))
            return date(year, month, 1 if start else calendar.monthrange(year, month)[1])
        except (TypeError, ValueError) as exc:
            raise AcquisitionError("dates must use YYYY-MM or YYYY-MM-DD format") from exc
    try:
        return date.fromisoformat(value)
    except (TypeError, ValueError) as exc:
        raise AcquisitionError("dates must use YYYY-MM or YYYY-MM-DD format") from exc


def validate_date_range(start_date: date | str, end_date: date | str) -> tuple[date, date]:
    start = _parse_date(start_date, True)
    end = _parse_date(end_date, False)
    if start > end:
        raise AcquisitionError("start_date must be on or before end_date")
    return start, end


def _month_windows(start: date, end: date):
    current = start.replace(day=1)
    while current <= end:
        month_end = date(current.year, current.month, calendar.monthrange(current.year, current.month)[1])
        yield current.strftime("%Y-%m"), max(start, current), min(end, month_end)
        current = month_end + timedelta(days=1)


def _properties(item: Any) -> Mapping[str, Any]:
    value = getattr(item, "properties", None)
    return value if isinstance(value, Mapping) else {}


def _item_date(item: Any) -> date:
    value = getattr(item, "datetime", None) or _properties(item).get("datetime")
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    if isinstance(value, str):
        try:
            return datetime.fromisoformat(value.replace("Z", "+00:00")).date()
        except ValueError:
            pass
    raise AcquisitionError("STAC item did not include a valid acquisition date")


def _cloud_cover(item: Any) -> float:
    properties = _properties(item)
    value = properties.get("eo:cloud_cover", properties.get("cloud_cover", 100.0))
    try:
        return float(value)
    except (TypeError, ValueError):
        return 100.0


def _item_bbox(item: Any, fallback: tuple[float, float, float, float]):
    value = getattr(item, "bbox", None) or _properties(item).get("bbox")
    if isinstance(value, (list, tuple)) and len(value) >= 4:
        return tuple(float(coordinate) for coordinate in value[:4])
    return fallback


def _item_crs(item: Any) -> str:
    value = _properties(item).get("proj:epsg") or _properties(item).get("proj:code")
    if value:
        return str(value if str(value).upper().startswith("EPSG:") else f"EPSG:{value}")
    return "EPSG:4326"


def _search_items(search: Any) -> list[Any]:
    if hasattr(search, "item_collection"):
        return list(search.item_collection())
    if hasattr(search, "items"):
        return list(search.items())
    return list(search)


class _STACFetcher:
    collection: str
    source: str
    mode: str
    asset_keys: Mapping[str, tuple[str, ...]]
    required_bands: tuple[str, ...]

    def __init__(
        self,
        *,
        catalog: Any | None = None,
        catalog_url: str = PLANETARY_COMPUTER_STAC_URL,
        signer: Callable[[Any], Any] | None = None,
        client_factory: Callable[..., Any] | None = None,
        asset_reader: Callable[..., np.ndarray] | None = None,
        max_size: int = 512,
        timeout: float | tuple[float, float] = (10.0, 60.0),
    ) -> None:
        if max_size < 1:
            raise ValueError("max_size must be positive")
        self.catalog = catalog
        self.catalog_url = catalog_url
        self.signer = signer
        self.client_factory = client_factory
        self.asset_reader = asset_reader
        self.max_size = max_size
        self.timeout = timeout

    def _catalog(self) -> Any:
        if self.catalog is not None:
            return self.catalog
        if pystac_client is None:
            raise AcquisitionError("pystac-client is unavailable")
        factory = self.client_factory or pystac_client.Client.open
        try:
            try:
                return factory(self.catalog_url, timeout=self.timeout)
            except TypeError:
                return factory(self.catalog_url)
        except Exception as exc:
            raise AcquisitionError(f"Planetary Computer STAC request failed: {exc}") from exc

    def _sign(self, item: Any) -> Any:
        signer = self.signer
        if signer is None:
            if planetary_computer is None:
                raise AcquisitionError("planetary-computer is unavailable")
            signer = planetary_computer.sign
        try:
            return signer(item) or item
        except Exception as exc:
            raise AcquisitionError(f"Planetary Computer asset signing failed: {exc}") from exc

    def search_month(
        self,
        bbox: tuple[float, float, float, float],
        start: date,
        end: date,
    ) -> list[Any]:
        try:
            search = self._catalog().search(
                collections=[self.collection],
                bbox=list(bbox),
                datetime=f"{start.isoformat()}/{end.isoformat()}",
            )
            return _search_items(search)
        except AcquisitionError:
            raise
        except Exception as exc:
            raise AcquisitionError(f"Planetary Computer STAC search failed: {exc}") from exc

    def _read_asset(self, asset: Any) -> np.ndarray:
        href = getattr(asset, "href", None)
        if href is None and isinstance(asset, Mapping):
            href = asset.get("href")
        if not href:
            raise AcquisitionError("STAC asset did not include an href")
        try:
            if self.asset_reader is not None:
                try:
                    return np.asarray(self.asset_reader(href, max_size=self.max_size), dtype=np.float32)
                except TypeError:
                    return np.asarray(self.asset_reader(href), dtype=np.float32)
            return safe_read_raster(href, max_size=self.max_size, dtype=np.float32)
        except AcquisitionError:
            raise
        except Exception as exc:
            raise AcquisitionError(f"satellite raster request failed: {exc}") from exc

    def _scene(self, item: Any, bbox: tuple[float, float, float, float]) -> Asset:
        signed = self._sign(item)
        assets = getattr(signed, "assets", None)
        if assets is None and isinstance(signed, Mapping):
            assets = signed.get("assets")
        if not isinstance(assets, Mapping):
            raise AcquisitionError("signed STAC item did not include assets")
        bands: dict[str, np.ndarray] = {}
        for name, candidates in self.asset_keys.items():
            asset = next((assets.get(candidate) for candidate in candidates if assets.get(candidate)), None)
            if asset is None:
                if name in self.required_bands:
                    raise AcquisitionError(f"STAC item is missing required asset {name}")
                continue
            bands[name] = self._read_asset(asset)
        item_id = str(getattr(item, "id", None) or _properties(item).get("id", "unknown"))
        return Asset(
            source=self.source,
            scene_id=item_id,
            acquisition_date=_item_date(item),
            cloud_cover=_cloud_cover(item),
            bbox=_item_bbox(item, bbox),
            crs=_item_crs(item),
            bands=bands,
            mode=self.mode,
            properties=dict(_properties(item)),
        )

    def _lowest_cloud(self, items: list[Any]) -> Any | None:
        if not items:
            return None
        return min(items, key=lambda item: (_cloud_cover(item), _item_date(item)))

    def fetch_monthly(self, query: InputConfig) -> list[Asset]:
        bbox = validate_bbox(query.bbox)
        start, end = validate_date_range(query.start_date, query.end_date)
        scenes: list[Asset] = []
        for month, window_start, window_end in _month_windows(start, end):
            items = self.search_month(bbox, window_start, window_end)
            item = self._lowest_cloud(items)
            if item is None:
                LOGGER.info("No %s scene found for %s", self.source, month)
                continue
            try:
                scenes.append(self._scene(item, bbox))
            except Exception as exc:
                LOGGER.warning("Skipping %s scene for %s: %s", self.source, month, exc)
        return scenes

    def fetch(self, query: InputConfig) -> list[Asset]:
        return self.fetch_monthly(query)


class Sentinel2Fetcher(_STACFetcher):
    """Sentinel-2 L2A optical fetcher."""

    collection = "sentinel-2-l2a"
    source = "sentinel-2"
    mode = "optical"
    asset_keys = {
        "blue": ("B02", "blue"),
        "green": ("B03", "green"),
        "red": ("B04", "red"),
        "nir": ("B08", "nir"),
    }
    required_bands = ("red", "nir")


class Sentinel1RTCFetcher(_STACFetcher):
    """Sentinel-1 RTC SAR fetcher used for cloud-obscured months."""

    collection = "sentinel-1-rtc"
    source = "sentinel-1-rtc"
    mode = "sar"
    asset_keys = {
        "vv": ("vv", "VV", "vv-gamma0"),
        "vh": ("vh", "VH", "vh-gamma0"),
    }
    required_bands = ("vv",)


class AcquisitionPipeline:
    """Fetch optical scenes and fall back to SAR above the cloud threshold."""

    def __init__(
        self,
        optical: Sentinel2Fetcher | None = None,
        sar: Sentinel1RTCFetcher | None = None,
        *,
        cloud_threshold: float = 60.0,
    ) -> None:
        if not 0 <= cloud_threshold <= 100:
            raise ValueError("cloud_threshold must be between 0 and 100")
        self.optical = optical or Sentinel2Fetcher()
        self.sar = sar or Sentinel1RTCFetcher()
        self.cloud_threshold = cloud_threshold

    def fetch(self, query: InputConfig) -> list[Asset]:
        bbox = validate_bbox(query.bbox)
        start, end = validate_date_range(query.start_date, query.end_date)
        if query.satellite == "sentinel-1-rtc":
            scenes = self.sar.fetch_monthly(query)
            if not scenes:
                raise NoScenesError("No Sentinel-1 RTC scenes were available for the request")
            return scenes

        scenes: list[Asset] = []
        for month, window_start, window_end in _month_windows(start, end):
            optical_items = self.optical.search_month(bbox, window_start, window_end)
            optical_item = self.optical._lowest_cloud(optical_items)
            if optical_item is None:
                continue
            cloud_cover = _cloud_cover(optical_item)
            if cloud_cover > self.cloud_threshold and query.satellite == "auto":
                LOGGER.info(
                    "Optical cloud cover %.1f%% exceeds %.1f%% for %s; trying Sentinel-1 RTC",
                    cloud_cover,
                    self.cloud_threshold,
                    month,
                )
                sar_items = self.sar.search_month(bbox, window_start, window_end)
                sar_item = self.sar._lowest_cloud(sar_items)
                if sar_item is not None:
                    try:
                        scenes.append(self.sar._scene(sar_item, bbox))
                        continue
                    except Exception as exc:
                        LOGGER.warning("SAR fallback failed for %s: %s", month, exc)
            try:
                scenes.append(self.optical._scene(optical_item, bbox))
            except Exception as exc:
                LOGGER.warning("Skipping optical scene for %s: %s", month, exc)
        if not scenes:
            raise NoScenesError(
                "No satellite scenes were available for the selected area and date range"
            )
        return scenes
