import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import maplibregl, {
  NavigationControl,
  type Map as MapLibreMap,
  type MapOptions,
  type ProjectionSpecification,
  type StyleSpecification,
} from "maplibre-gl";
import AgentWarRoomModal, {
  type AgentLoopState,
  type AgentNodeState,
} from "../components/AgentWarRoomModal";
import AnalysisReport, { type AnalysisReportData } from "../components/AnalysisReport";
import type {
  AnalysisStep,
  AreaContext,
  AgentLog,
  AgentLogTag,
  BackendTraceStep,
  DateRange,
  Measurement,
  MonthlyResult,
  TimeSeriesResponse,
} from "../types";

// Keep the default basemap deliberately simple. The previous remote vector
// style referenced numeric feature properties that are null on some tiles and
// requested sprite images that are not present, producing noisy MapLibre
// errors unrelated to the selected-area workflow.
const DEFAULT_MAP_STYLE: StyleSpecification = {
  version: 8,
  sources: {
    osm: {
      type: "raster",
      tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
      tileSize: 256,
      maxzoom: 19,
      attribution: "© OpenStreetMap contributors",
    },
  },
  layers: [
    {
      id: "osm-raster",
      type: "raster",
      source: "osm",
      paint: { "raster-opacity": 1 },
    },
  ],
};
const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || "http://localhost:8000").replace(/\/$/, "");
const SELECTED_AREA_SOURCE_ID = "selected-area-source";
const SELECTED_AREA_FILL_LAYER_ID = "selected-area-fill";
const SELECTED_AREA_STROKE_LAYER_ID = "selected-area-stroke";
const INITIAL_CENTER: [number, number] = [78.9629, 20.5937];
const INITIAL_ZOOM = 1.8;
const PROJECTION_THRESHOLD = 7;
const ANALYSIS_TIMEOUT_MS = 60_000;

type ProjectionName = "globe" | "mercator";
type DrawBbox = [number, number, number, number];

interface NominatimResult {
  place_id: number;
  display_name: string;
  lat: string;
  lon: string;
  type: string;
  boundingbox?: [string, string, string, string];
}

function projectionFor(name: ProjectionName): ProjectionSpecification {
  return { type: name };
}

function parseCoordinates(value: string): [number, number] | null {
  const match = value.trim().match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/);
  if (!match) return null;

  const latitude = Number(match[1]);
  const longitude = Number(match[2]);
  if (
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    latitude < -90 ||
    latitude > 90 ||
    longitude < -180 ||
    longitude > 180
  ) {
    return null;
  }
  return [longitude, latitude];
}

function shortPlaceName(displayName: string): string {
  return displayName.split(",")[0]?.trim() || displayName;
}

function searchAreaLabel(result: NominatimResult): string {
  const place = shortPlaceName(result.display_name);
  const region = result.display_name.split(",")[1]?.trim();
  const abbreviation = region === "Maharashtra" ? "MH" : region;
  return abbreviation ? `${place}, ${abbreviation} (Bounding Box Active)` : `${place} (Bounding Box Active)`;
}

function formatTimestamp(date = new Date()): string {
  return date.toISOString().slice(11, 23);
}

function createBboxGeoJson(bbox: DrawBbox | null): AnalysisReportData["geoJson"] {
  if (!bbox) return { type: "FeatureCollection", features: [] };

  const [minLongitude, minLatitude, maxLongitude, maxLatitude] = bbox;
  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: { source: "SatQuery AI selected analysis bbox" },
        geometry: {
          type: "Polygon",
          coordinates: [[
            [minLongitude, minLatitude],
            [maxLongitude, minLatitude],
            [maxLongitude, maxLatitude],
            [minLongitude, maxLatitude],
            [minLongitude, minLatitude],
          ]],
        },
      },
    ],
  };
}

function ensureSelectedAreaOverlay(map: MapLibreMap, bbox: DrawBbox | null): void {
  if (!map.isStyleLoaded()) return;

  if (!map.getSource(SELECTED_AREA_SOURCE_ID)) {
    map.addSource(SELECTED_AREA_SOURCE_ID, {
      type: "geojson",
      data: createBboxGeoJson(null),
    });
  }
  if (!map.getLayer(SELECTED_AREA_FILL_LAYER_ID)) {
    map.addLayer({
      id: SELECTED_AREA_FILL_LAYER_ID,
      type: "fill",
      source: SELECTED_AREA_SOURCE_ID,
      paint: {
        "fill-color": "#00e5ff",
        "fill-opacity": 0.28,
      },
    });
  }
  if (!map.getLayer(SELECTED_AREA_STROKE_LAYER_ID)) {
    map.addLayer({
      id: SELECTED_AREA_STROKE_LAYER_ID,
      type: "line",
      source: SELECTED_AREA_SOURCE_ID,
      paint: {
        "line-color": "#0369a1",
        "line-width": 4,
        "line-opacity": 1,
        "line-dasharray": [2, 1],
      },
    });
  }

  const source = map.getSource(SELECTED_AREA_SOURCE_ID) as
    | { setData: (data: AnalysisReportData["geoJson"]) => void }
    | undefined;
  source?.setData(createBboxGeoJson(bbox));
}

function bboxCenter(bbox: DrawBbox): [number, number] {
  return [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2];
}

function bboxAreaKm2(bbox: DrawBbox): number {
  const [west, south, east, north] = bbox;
  const latitudeScale = 111.32;
  const longitudeScale = latitudeScale * Math.cos((((south + north) / 2) * Math.PI) / 180);
  return Math.abs(east - west) * longitudeScale * Math.abs(north - south) * latitudeScale;
}

function bboxAroundCenter(center: [number, number]): DrawBbox {
  const [longitude, latitude] = center;
  const halfWidth = 0.01;
  const halfHeight = 0.006;
  return [
    Math.max(-180, longitude - halfWidth),
    Math.max(-90, latitude - halfHeight),
    Math.min(180, longitude + halfWidth),
    Math.min(90, latitude + halfHeight),
  ];
}

function parseNominatimBbox(boundingbox?: NominatimResult["boundingbox"]): DrawBbox | null {
  if (!boundingbox || boundingbox.length !== 4) return null;
  const [south, north, west, east] = boundingbox.map((value) => parseFloat(value));
  if (
    ![south, north, west, east].every(Number.isFinite) ||
    south < -90 || north > 90 || west < -180 || east > 180 ||
    west >= east || south >= north
  ) {
    return null;
  }
  return [west, south, east, north];
}

function hasLoadedStyle(map: MapLibreMap): boolean {
  try {
    return Boolean(map.getStyle() && map.isStyleLoaded());
  } catch {
    return false;
  }
}

function formatBbox(bbox: DrawBbox): string {
  return bbox.map((coordinate) => coordinate.toFixed(4)).join(", ");
}

function toApiMonth(value: string): string {
  return value.slice(0, 7);
}

function clampPercentage(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : null;
}

function asNumber(value: unknown, fallback = 0): number {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function asText(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function apiErrorMessage(payload: unknown, status: number): string {
  const record = asRecord(payload);
  const detail = record?.detail ?? record?.error ?? record?.message;
  if (typeof detail === "string" && detail.trim()) return detail;
  if (asRecord(detail)?.message && typeof asRecord(detail)?.message === "string") {
    return asRecord(detail)?.message as string;
  }
  return `Imagery analysis failed${status ? ` (HTTP ${status})` : ""}.`;
}

function normalizeBackendResponse(payload: unknown): TimeSeriesResponse {
  const root = asRecord(payload);
  if (!root) throw new Error("The imagery API returned an invalid response.");

  const rootStatus = typeof root.status === "string" ? root.status.toLowerCase() : "";
  const data = asRecord(root.data) ?? asRecord(root.result) ?? root;
  const rawResults = [
    data?.results,
    data?.months,
    data?.monthly,
    data?.timeline,
    root.results,
    root.months,
  ].find(Array.isArray);

  if (!Array.isArray(rawResults)) {
    if (rootStatus === "error") {
      return {
        status: "error",
        query: asText(root.query, "Imagery analysis"),
        bbox: Array.isArray(root.bbox) ? root.bbox.map((value) => asNumber(value)) : [],
        confidence: asNumber(root.confidence, 0),
        metrics: {},
        trace: [],
        answer: "",
        summary: "",
        months: [],
        overall_summary: "",
        error: asText(data?.error ?? root.error, "Backend analysis failed."),
        analysis_logs: [],
      };
    }
    throw new Error("The imagery API response did not include monthly results.");
  }

  const months: MonthlyResult[] = rawResults.map((value, index) => {
    const result = asRecord(value) ?? {};
    const details = asRecord(result.details);
    const metricRecord = asRecord(result.metrics) ?? {};
    const changeRecord = asRecord(result.change_from_previous);
    return {
      date: asText(result.date ?? result.month ?? result.period ?? result.acquisition_date, `Observation ${index + 1}`),
      scene_id: asText(result.scene_id, `scene-${index + 1}`),
      cloud_cover: asNumber(result.cloud_cover ?? result.cloud_percentage ?? result.cloud_percent ?? result.cloud),
      metrics: Object.fromEntries(
        Object.entries(metricRecord).flatMap(([key, value]) => {
          const number = asNumber(value, Number.NaN);
          return Number.isFinite(number) ? [[key, number]] : [];
        }),
      ),
      change_from_previous: changeRecord
        ? Object.fromEntries(Object.entries(changeRecord).flatMap(([key, value]) => {
            const number = asNumber(value, Number.NaN);
            return Number.isFinite(number) ? [[key, number]] : [];
          }))
        : null,
      summary: asText(result.summary, "Monthly imagery observation."),
      thumbnail_b64: asText(result.thumbnail_b64, "") || null,
    };
  });

  const rawLogs = [
    data?.analysis_logs,
    data?.logs,
    root.analysis_logs,
    root.logs,
  ].find(Array.isArray);
  const analysis_logs = Array.isArray(rawLogs)
    ? rawLogs.flatMap((value) => {
        const log = asRecord(value);
        if (!log) return [];
        const message = asText(log.message ?? log.text, "");
        return message ? [{ tag: asText(log.tag, "API"), message }] : [];
      })
    : [];

  const status = rootStatus === "error" ? "error" : "ok";
  const rawTrace = [data?.trace, root.trace].find(Array.isArray);
  const trace: BackendTraceStep[] = Array.isArray(rawTrace)
    ? rawTrace.flatMap((value) => {
        const step = asRecord(value);
        if (!step) return [];
        const output = asRecord(step.output) ?? {};
        const params = asRecord(step.params) ?? {};
        const toolName = asText(step.tool_name, "backend.step");
        const duration = asNumber(step.duration_ms);
        const stepStatus = step.status === "error" ? "error" : "ok";
        return [{
          tool_name: toolName,
          duration_ms: duration,
          params,
          output,
          status: stepStatus,
        }];
      })
    : [];
  const rawMetrics = asRecord(data?.metrics) ?? asRecord(root.metrics) ?? {};
  const metrics = Object.fromEntries(
    Object.entries(rawMetrics).flatMap(([key, value]) => {
      const number = asNumber(value, Number.NaN);
      return Number.isFinite(number) ? [[key, number]] : [];
    }),
  );
  return {
    status,
    query: asText(root.query, "Imagery analysis"),
    bbox: Array.isArray(root.bbox) ? root.bbox.map((value) => asNumber(value)) : [],
    confidence: asNumber(root.confidence, 0),
    metrics,
    trace,
    answer: asText(data?.answer, asText(data?.summary, asText(root.answer, asText(root.summary, asText(root.overall_summary, ""))))),
    summary: asText(data?.summary, asText(root.summary, asText(root.overall_summary, ""))),
    months,
    overall_summary: asText(root.overall_summary, "Monthly imagery analysis completed."),
    error: typeof root.error === "string" ? root.error : null,
    analysis_logs,
  };
}

function formatMetric(value: number | undefined, digits = 1): string {
  return Number.isFinite(value) ? `${value!.toFixed(digits)}%` : "n/a";
}

function backendMeasurements(metrics: Record<string, number>): Measurement[] {
  const definitions: Array<[string, string, string, number | undefined]> = [
    ["Vegetation", "bg-emerald-500", "vegetation_coverage_percentage", metrics.vegetation_coverage_percentage ?? metrics.ndvi_vegetation_percentage],
    ["Water", "bg-cyan-600", "water_coverage_percentage", metrics.water_coverage_percentage ?? metrics.ndwi_water_percentage],
    ["Change", "bg-blue-600", "changed_area_percentage", metrics.changed_area_percentage],
    ["Cloud", "bg-slate-500", "cloud_cover", metrics.cloud_cover],
  ];
  return definitions
    .filter(([, , , value]) => Number.isFinite(value))
    .map(([label, color, , value]) => ({
      label,
      value: formatMetric(value),
      color,
      percentage: clampPercentage(value ?? 0),
    }));
}

function traceNodes(trace: BackendTraceStep[]): AgentNodeState[] {
  return trace.map((step, index) => {
    const readableName = step.tool_name
      .split(".")
      .map((part) => part.replace(/[-_]/g, " "))
      .join(" / ")
      .replace(/\b\w/g, (letter) => letter.toUpperCase());
    return {
      id: `${step.tool_name}-${index}`,
      name: readableName,
      role: step.tool_name.startsWith("agent.") ? "controller stage" : "backend tool",
      phase: step.status === "error" ? "error" : "complete",
      detail: step.status === "error" ? String(step.output.error ?? "tool failed") : JSON.stringify(step.output),
    };
  });
}

function normalizeAgentLogTag(value: string): AgentLogTag {
  const allowedTags: AgentLogTag[] = ["SYS", "E2B", "AGT", "LOG", "OUT"];
  return allowedTags.includes(value as AgentLogTag) ? value as AgentLogTag : "LOG";
}

function backendLogs(
  trace: BackendTraceStep[],
  analysisLogs: Array<{ tag: string; message: string }> = [],
): AgentLog[] {
  if (trace.length) {
    return trace.map((step, index) => ({
      id: index + 1,
      tag: step.status === "error" ? "LOG" : "AGT",
      message: `[${step.tool_name}] ${step.status === "error" ? String(step.output.error ?? "tool failed") : JSON.stringify({ params: step.params, output: step.output })}`,
      timestamp: `${Math.round(step.duration_ms)} ms`,
    }));
  }

  return analysisLogs.map((log, index) => ({
    id: index + 1,
    tag: normalizeAgentLogTag(log.tag),
    message: log.message,
    timestamp: "API",
  }));
}

function createBackendReport(
  query: string,
  response: TimeSeriesResponse,
  latencyMs: number,
  bbox: DrawBbox,
): AnalysisReportData {
  const metrics = response.metrics ?? {};
  const change = metrics.changed_area_percentage ?? 0;
  const area = metrics.area_hectares;
  const summary = response.answer || response.summary || response.overall_summary;
  const findings = Object.entries(metrics)
    .filter(([, value]) => Number.isFinite(value))
    .slice(0, 8)
    .map(([key, value]) => ({
      label: key.replace(/_/g, " "),
      value: Number.isInteger(value) ? String(value) : value.toFixed(2),
      detail: "computed by the v2 backend",
    }));
  if (response.months.length) {
    findings.push({
      label: "observations",
      value: String(response.months.length),
      detail: "validated monthly scenes returned by the backend",
    });
  }
  return {
    queryTitle: query,
    model: "SatQuery AI v2 backend",
    latencyMs,
    confidence: Math.round(clampPercentage((response.confidence ?? 0) * 100)),
    summary,
    measurements: backendMeasurements(metrics),
    totalArea: Number.isFinite(area) ? `${area!.toFixed(2)} ha` : "n/a",
    structureShifts: formatMetric(change),
    sourceScene: `bbox [${formatBbox(bbox)}]`,
    recommendation: change > 0
      ? "Review the detected change against the returned thumbnails and consider a follow-up capture or field verification."
      : "Use the validated observations as a baseline and continue monitoring the selected extent.",
    findings,
    geoJson: createBboxGeoJson(bbox),
    timeline: response.months,
  };
}

function StatusDot({ active = false }: { active?: boolean }) {
  return (
    <span
      className={`inline-block h-2 w-2 rounded-full ${
        active ? "animate-pulse bg-emerald-400" : "bg-slate-500"
      }`}
      aria-hidden="true"
    />
  );
}

export default function MapView({
  styleUrl = DEFAULT_MAP_STYLE,
}: {
  styleUrl?: string | StyleSpecification;
}) {
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const highlightMarkerRef = useRef<maplibregl.Marker | null>(null);
  const mapReadyRef = useRef(false);
  const projectionRef = useRef<ProjectionName>("globe");
  const searchAbortRef = useRef<AbortController | null>(null);
  const analysisAbortRef = useRef<AbortController | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const analysisStartedAtRef = useRef<number | null>(null);

  const [mapReady, setMapReady] = useState(false);
  const [overlayRevision, setOverlayRevision] = useState(0);
  const [basemapError, setBasemapError] = useState(false);
  const [projection, setProjection] = useState<ProjectionName>("globe");
  const [searchValue, setSearchValue] = useState("");
  const [suggestions, setSuggestions] = useState<NominatimResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [areaContext, setAreaContext] = useState<AreaContext | null>(null);
  const [areaCenter, setAreaCenter] = useState<[number, number]>(INITIAL_CENTER);
  const [drawAreaMode, setDrawAreaMode] = useState(false);
  const [isDrawing, setIsDrawing] = useState(false);
  const [draftBbox, setDraftBbox] = useState<DrawBbox | null>(null);
  const [drawBbox, setDrawBbox] = useState<DrawBbox | null>(null);
  const [searchBbox, setSearchBbox] = useState<DrawBbox | null>(null);
  const [selectedAreaKm2, setSelectedAreaKm2] = useState<number | null>(null);
  const [drawError, setDrawError] = useState<string | null>(null);
  const [dateRange, setDateRange] = useState<DateRange>({
    from: "2024-01-01",
    to: "2025-01-31",
  });
  const [datesOpen, setDatesOpen] = useState(false);
  const [attachmentsOpen, setAttachmentsOpen] = useState(false);
  const [attachmentName, setAttachmentName] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [analysisSteps, setAnalysisSteps] = useState<AnalysisStep[]>([]);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [agentLoop, setAgentLoop] = useState<AgentLoopState>(() => ({
    phase: "pending",
    attempt: 1,
    nodes: [],
    logs: [],
    isComplex: false,
  }));
  const [agentToast, setAgentToast] = useState("Ready to plan a local scene analysis.");
  const [analysisReport, setAnalysisReport] = useState<AnalysisReportData | null>(null);
  const [timeSeriesResponse, setTimeSeriesResponse] = useState<TimeSeriesResponse | null>(null);
  const [analysisLogs, setAnalysisLogs] = useState<Array<{ tag: string; message: string }> | null>(null);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [highlighted, setHighlighted] = useState(false);
  const [warRoomOpen, setWarRoomOpen] = useState(false);
  const activeAreaBbox = draftBbox ?? searchBbox ?? drawBbox;

  const cancelActiveAnalysis = useCallback(() => {
    analysisAbortRef.current?.abort();
    analysisAbortRef.current = null;
    setIsAnalyzing(false);
    setWarRoomOpen(false);
  }, []);

  useEffect(() => {
    const container = mapContainerRef.current;
    if (!container || mapRef.current) return;

    // A new style load starts clean. The warning is reserved for a fatal
    // tile error; successful style/load/idle events clear it below.
    setBasemapError(false);
    setMapReady(false);
    mapReadyRef.current = false;
    let map: MapLibreMap | null = null;
    const handleZoom = () => {
      if (!map || !hasLoadedStyle(map)) return;
      const nextProjection: ProjectionName =
        map.getZoom() >= PROJECTION_THRESHOLD ? "mercator" : "globe";
      if (nextProjection === projectionRef.current) return;

      try {
        map.setProjection(projectionFor(nextProjection));
        projectionRef.current = nextProjection;
        setProjection(nextProjection);
      } catch (error) {
        console.warn(
          error instanceof Error ? error.message : "Projection transition failed.",
        );
      }
    };
    const handleMapLoad = () => {
      mapReadyRef.current = true;
      setMapReady(true);
      setOverlayRevision((revision) => revision + 1);
      setBasemapError(false);
    };
    const handleStyleLoad = () => {
      if (!map) return;
      try {
        map.setProjection(projectionFor("globe"));
        const atmosphericFog = {
          color: "rgba(255, 255, 255, 0.8)",
          "high-color": "rgba(36, 92, 223, 0.2)",
          "space-color": "#0b1121",
          "star-intensity": 0.15,
        };
        // Newer MapLibre builds expose setFog. The pinned build uses the
        // equivalent sky API, so keep both paths for a consistent atmosphere.
        const fogCapableMap = map as MapLibreMap & {
          setFog?: (fog: typeof atmosphericFog) => void;
        };
        if (fogCapableMap.setFog) {
          fogCapableMap.setFog(atmosphericFog);
        } else {
          map.setSky({
            "sky-color": "#0b1121",
            "horizon-color": "rgba(36, 92, 223, 0.2)",
            "fog-color": "rgba(255, 255, 255, 0.8)",
            "fog-ground-blend": 0.55,
            "horizon-fog-blend": 0.35,
            "atmosphere-blend": 0.35,
          });
        }
        projectionRef.current = "globe";
        setProjection("globe");
      } catch (error) {
        console.warn(
          error instanceof Error ? error.message : "Initial projection transition failed.",
        );
      }
      mapReadyRef.current = true;
      setMapReady(true);
      // A style reload removes application-added sources and layers. Bump a
      // revision so the overlay effect recreates and repopulates the bbox.
      setOverlayRevision((revision) => revision + 1);
      setBasemapError(false);
    };
    const handleMapIdle = () => {
      // A style can finish loading before all vector/raster tiles arrive. The
      // idle event is the safe point at which the visible basemap is ready.
      if (map && hasLoadedStyle(map)) setBasemapError(false);
    };
    const handleMapError = (event: maplibregl.ErrorEvent) => {
      const message = event.error?.message || "";
      const tileEvent = event as maplibregl.ErrorEvent & { tile?: unknown };

      // Tile 404s/timeouts can be emitted while MapLibre is still assembling
      // the style. They should not cover the working UI with a fatal banner.
      const isTileError = Boolean(tileEvent.tile) || /tile|raster|glyph|sprite/i.test(message);
      const isFatalTileError =
        Boolean(event.error) &&
        isTileError &&
        !mapReadyRef.current &&
        !map?.isStyleLoaded();

      if (isFatalTileError) setBasemapError(true);
    };
    const handleStyleImageMissing = (event: { id: string }) => {
      if (!map || map.hasImage(event.id)) return;
      try {
        // Custom styles may request an icon that is absent from their sprite.
        // A transparent placeholder prevents repeated missing-image errors.
        map.addImage(event.id, {
          width: 1,
          height: 1,
          data: new Uint8Array(4),
        });
      } catch {
        // The style can be replaced while this event is being delivered.
      }
    };

    try {
      // Apply the initial projection from style.load. Calling setProjection
      // before the URL style is ready throws "Style is not done loading".
      const mapOptions = {
        container,
        style: styleUrl,
        center: INITIAL_CENTER,
        zoom: INITIAL_ZOOM,
        pitch: 0,
        padding: { bottom: 150 },
      } as MapOptions;
      map = new maplibregl.Map(mapOptions);
      mapRef.current = map;
      map.addControl(new NavigationControl({ showCompass: true }), "bottom-left");
      map.on("zoom", handleZoom);
      map.on("error", handleMapError);
      map.on("styleimagemissing", handleStyleImageMissing);
      map.on("style.load", handleStyleLoad);
      map.once("load", handleMapLoad);
      map.on("idle", handleMapIdle);
      map.on("webglcontextlost", () => {
        mapReadyRef.current = false;
        setMapReady(false);
      });
      map.on("webglcontextrestored", () => {
        // MapLibre reloads the style after restoration. style.load will mark
        // the map ready again and reconcile the GeoJSON overlays.
        setBasemapError(false);
      });
    } catch (error) {
      console.error(
        error instanceof Error ? error.message : "Unable to initialize the map.",
      );
    }

    return () => {
      if (map) {
        map.off("zoom", handleZoom);
        map.off("error", handleMapError);
        map.off("styleimagemissing", handleStyleImageMissing);
        map.off("style.load", handleStyleLoad);
        map.off("idle", handleMapIdle);
        map.remove();
      }
      mapReadyRef.current = false;
      mapRef.current = null;
      setMapReady(false);
      setBasemapError(false);
    };
  }, [styleUrl]);

  useEffect(() => {
    const map = mapRef.current;
    highlightMarkerRef.current?.remove();
    highlightMarkerRef.current = null;
    if (!map || !mapReady || !hasLoadedStyle(map) || (!activeAreaBbox && !highlighted)) return;

    const markerCenter = activeAreaBbox ? bboxCenter(activeAreaBbox) : areaCenter;

    const markerElement = document.createElement("div");
    markerElement.className = "h-5 w-5 rounded-full border-2 border-cyan-100 bg-cyan-400 shadow-[0_0_0_6px_rgba(0,240,255,0.3),0_0_24px_rgba(0,240,255,0.95)] motion-safe:animate-pulse";
    markerElement.setAttribute("aria-label", "Highlighted analysis extent");
    const marker = new maplibregl.Marker({ element: markerElement, anchor: "center" })
      .setLngLat(markerCenter)
      .addTo(map);
    highlightMarkerRef.current = marker;

    return () => {
      if (mapRef.current !== map) return;
      marker.remove();
      if (highlightMarkerRef.current === marker) highlightMarkerRef.current = null;
    };
  }, [activeAreaBbox, areaCenter, highlighted, mapReady]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || !hasLoadedStyle(map)) return;
    ensureSelectedAreaOverlay(map, activeAreaBbox);
  }, [activeAreaBbox, mapReady, overlayRevision]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;

    let startPoint: [number, number] | null = null;
    const setDraftFromPoint = (point: [number, number]) => {
      if (!startPoint) return;
      const nextBbox: DrawBbox = [
        Math.min(startPoint[0], point[0]),
        Math.min(startPoint[1], point[1]),
        Math.max(startPoint[0], point[0]),
        Math.max(startPoint[1], point[1]),
      ];
      setDraftBbox(nextBbox);
    };
    const cancelDrawing = () => {
      startPoint = null;
      setIsDrawing(false);
      setDraftBbox(null);
      setDrawAreaMode(false);
      map.dragPan.enable();
    };
    const finishDrawing = (point: [number, number]) => {
      if (!startPoint) return;
      const nextBbox: DrawBbox = [
        Math.min(startPoint[0], point[0]),
        Math.min(startPoint[1], point[1]),
        Math.max(startPoint[0], point[0]),
        Math.max(startPoint[1], point[1]),
      ];
      startPoint = null;
      setIsDrawing(false);
      setDraftBbox(null);
      setDrawAreaMode(false);
      map.dragPan.enable();

      if (nextBbox[2] - nextBbox[0] < 0.00001 || nextBbox[3] - nextBbox[1] < 0.00001) {
        setDrawError("Drag across a larger area to select a bounding box.");
        return;
      }

      cancelActiveAnalysis();
      setDrawError(null);
      setDrawBbox(nextBbox);
      setSearchBbox(null);
      setSelectedAreaKm2(bboxAreaKm2(nextBbox));
      setAreaCenter(bboxCenter(nextBbox));
      setAreaContext({ label: "Selected Area", area: `${bboxAreaKm2(nextBbox).toFixed(2)} km²` });
      setAnalysisReport(null);
      setTimeSeriesResponse(null);
      setAnalysisLogs(null);
      setAnalysisError(null);
      setHighlighted(false);
      map.fitBounds(
        [[nextBbox[0], nextBbox[1]], [nextBbox[2], nextBbox[3]]],
        { padding: 80, duration: 650, essential: true },
      );
    };
    const canvas = map.getCanvas();
    const canvasPoint = (event: MouseEvent): [number, number] => {
      const rect = canvas.getBoundingClientRect();
      const lngLat = map.unproject([event.clientX - rect.left, event.clientY - rect.top]);
      return [lngLat.lng, lngLat.lat];
    };
    const handleMouseDown = (event: MouseEvent) => {
      if (!drawAreaMode || event.button !== 0) return;
      event.preventDefault();
      startPoint = canvasPoint(event);
      setDrawError(null);
      setIsDrawing(true);
      setSearchBbox(null);
      setSelectedAreaKm2(null);
      setDraftBbox([startPoint[0], startPoint[1], startPoint[0], startPoint[1]]);
      setDrawBbox(null);
      map.dragPan.disable();
    };
    const handleMouseMove = (event: MouseEvent) => {
      if (!startPoint) return;
      setDraftFromPoint(canvasPoint(event));
    };
    const handleWindowMouseMove = (event: MouseEvent) => {
      if (!startPoint) return;
      setDraftFromPoint(canvasPoint(event));
    };
    const handleMouseUp = (event: MouseEvent) => {
      if (!startPoint) return;
      finishDrawing(canvasPoint(event));
    };
    const handleWindowMouseUp = (event: MouseEvent) => {
      if (!startPoint) return;
      finishDrawing(canvasPoint(event));
    };

    canvas.style.cursor = drawAreaMode ? "crosshair" : "";
    canvas.addEventListener("mousedown", handleMouseDown);
    canvas.addEventListener("mousemove", handleMouseMove);
    canvas.addEventListener("mouseup", handleMouseUp);
    window.addEventListener("mousemove", handleWindowMouseMove);
    window.addEventListener("mouseup", handleWindowMouseUp);

    return () => {
      canvas.removeEventListener("mousedown", handleMouseDown);
      canvas.removeEventListener("mousemove", handleMouseMove);
      canvas.removeEventListener("mouseup", handleMouseUp);
      window.removeEventListener("mousemove", handleWindowMouseMove);
      window.removeEventListener("mouseup", handleWindowMouseUp);
      canvas.style.cursor = "";
      if (startPoint) cancelDrawing();
      else map.dragPan.enable();
    };
  }, [cancelActiveAnalysis, drawAreaMode, mapReady]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    const canvas = map.getCanvas();
    if (isDrawing) {
      canvas.style.cursor = "crosshair";
      map.dragPan.disable();
    } else {
      canvas.style.cursor = drawAreaMode ? "crosshair" : "";
      map.dragPan.enable();
    }
  }, [drawAreaMode, isDrawing, mapReady]);

  useEffect(() => {
    return () => {
      searchAbortRef.current?.abort();
      analysisAbortRef.current?.abort();
    };
  }, []);

  const flyTo = useCallback((
    center: [number, number],
    label?: string,
    boundingbox?: NominatimResult["boundingbox"],
    keepSuggestions = false,
  ) => {
    cancelActiveAnalysis();
    setDrawAreaMode(false);
    setIsDrawing(false);
    setDraftBbox(null);
    setAnalysisReport(null);
    setTimeSeriesResponse(null);
    setAnalysisLogs(null);
    setAnalysisError(null);
    setHighlighted(false);
    const map = mapRef.current;
    const selectedBbox = parseNominatimBbox(boundingbox);
    if (selectedBbox) {
      // Nominatim returns [south, north, west, east].
      setDrawBbox(selectedBbox);
      setSearchBbox(selectedBbox);
      setSelectedAreaKm2(bboxAreaKm2(selectedBbox));
      map?.fitBounds(
        [[selectedBbox[0], selectedBbox[1]], [selectedBbox[2], selectedBbox[3]]],
        { padding: 80, duration: 2000, essential: true },
      );
    } else {
      setDrawBbox(null);
      setSearchBbox(null);
      setSelectedAreaKm2(null);
      map?.flyTo({ center, zoom: 14, essential: true });
    }
    setAreaCenter(center);
    if (label) {
      setAreaContext({
        label,
        area: selectedBbox ? `${bboxAreaKm2(selectedBbox).toFixed(2)} km²` : "point location",
      });
    }
    if (!keepSuggestions) setSuggestions([]);
    setSearchError(null);
  }, [cancelActiveAnalysis]);

  const searchLocations = useCallback(
    async (event?: FormEvent) => {
      event?.preventDefault();
      const value = searchValue.trim();
      if (!value) return;

      const coordinates = parseCoordinates(value);
      if (coordinates) {
        flyTo(coordinates, value);
        return;
      }

      searchAbortRef.current?.abort();
      const controller = new AbortController();
      searchAbortRef.current = controller;
      setSearching(true);
      setSearchError(null);
      try {
        const params = new URLSearchParams({
          q: value,
          format: "json",
          polygon_geojson: "1",
          limit: "5",
          addressdetails: "1",
        });
        const response = await fetch(
          `https://nominatim.openstreetmap.org/search?${params.toString()}`,
          {
            signal: controller.signal,
            headers: { "Accept-Language": "en" },
          },
        );
        if (!response.ok) throw new Error("Location search is temporarily unavailable.");
        const results = (await response.json()) as NominatimResult[];
        if (results.length === 0) {
          setSuggestions([]);
          setSearchError("No locations matched that search.");
        } else {
          // Navigate to the best match immediately, like a map search, while
          // retaining the place's bounding extent for region-level results.
          const first = results[0];
          const latitude = Number(first.lat);
          const longitude = Number(first.lon);
          if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
            throw new Error("This result did not include usable coordinates.");
          }
          setSearchValue(shortPlaceName(first.display_name));
          setSuggestions(results);
          flyTo([longitude, latitude], searchAreaLabel(first), first.boundingbox, true);
        }
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setSuggestions([]);
        setSearchError(error instanceof Error ? error.message : "Could not search locations.");
      } finally {
        if (!controller.signal.aborted) setSearching(false);
      }
    },
    [flyTo, searchValue],
  );

  const runBackendAnalysis = useCallback(async (query: string, bbox: DrawBbox, startDate: string, endDate: string) => {
    analysisAbortRef.current?.abort();
    const controller = new AbortController();
    analysisAbortRef.current = controller;
    let timedOut = false;
    const timeoutId = window.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, ANALYSIS_TIMEOUT_MS);

    setIsAnalyzing(true);
    setAnalysisError(null);
    setAnalysisReport(null);
    setTimeSeriesResponse(null);
    setAnalysisLogs(null);
    setHighlighted(false);
    setWarRoomOpen(true);
    setAnalysisSteps([
      {
        id: "backend-request",
        label: "Backend Agents Analyzing",
        detail: "Waiting for the controller trace and computed metrics",
        milliseconds: 0,
        status: "running",
      },
    ]);
    setAgentLoop({
      phase: "executing",
      attempt: 1,
      nodes: [
        {
          id: "backend-controller",
          name: "Backend Agents",
          role: "classifier · planner · executor · integrator",
          phase: "executing",
          detail: "Running the trace-backed v2 controller",
        },
      ],
      logs: [],
      isComplex: true,
    });
    setAgentToast("Backend Agents Analyzing… real STAC, validation, and tools are running");
    analysisStartedAtRef.current = Date.now();

    try {
      const response = await fetch(`${API_BASE_URL}/analyze`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          bbox,
          query,
          start_date: toApiMonth(startDate),
          end_date: toApiMonth(endDate),
        }),
        signal: controller.signal,
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(apiErrorMessage(payload, response.status));
      }
      const normalized = normalizeBackendResponse(payload);
      if (normalized.status === "error") {
        throw new Error(normalized.error || apiErrorMessage(payload, response.status));
      }
      const latency = Math.max(1, Date.now() - (analysisStartedAtRef.current ?? Date.now()));
      const responseLogs = backendLogs(normalized.trace ?? [], normalized.analysis_logs ?? []);
      const responseNodes = traceNodes(normalized.trace ?? []);
      setTimeSeriesResponse(normalized);
      setAnalysisLogs(normalized.analysis_logs ?? []);
      const traceSteps: AnalysisStep[] = (normalized.trace ?? []).map((step, index) => ({
        id: `${step.tool_name}-${index}`,
        label: step.tool_name,
        detail: step.status === "error" ? String(step.output.error ?? "tool failed") : JSON.stringify(step.output),
        milliseconds: Math.round(step.duration_ms),
        status: "done",
      }));
      setAnalysisSteps(traceSteps.length ? traceSteps : [{
        id: "backend-response",
        label: "Backend response received",
        detail: "No trace steps were returned",
        milliseconds: latency,
        status: "done",
      }]);
      setAnalysisReport(createBackendReport(query, normalized, latency, bbox));
      setAgentLoop((current) => ({
        ...current,
        phase: "complete",
        nodes: (responseNodes.length ? responseNodes : current.nodes)
          .map((node) => ({ ...node, phase: "complete" })),
        logs: responseLogs,
        reviewerMessage: "All reported steps completed in the backend.",
      }));
      setAgentToast("Backend Agents complete · trace, metrics, and report are ready");
      setIsAnalyzing(false);
      setWarRoomOpen(true);
    } catch (error) {
      if (controller.signal.aborted && !timedOut) return;
      const message = timedOut
        ? `Backend analysis timed out after ${ANALYSIS_TIMEOUT_MS / 1000} seconds.`
        : error instanceof Error ? error.message : "Could not reach the SatQuery AI backend.";
      const errorLog: AgentLog = {
        id: Date.now(),
        tag: "SYS",
        message: `[ERROR] Backend analysis failed: ${message}`,
        timestamp: formatTimestamp(),
      };
      setAnalysisError(message);
      setAnalysisLogs(null);
      setAgentLoop((current) => ({
        ...current,
        phase: "error",
        nodes: current.nodes.map((node) => ({ ...node, phase: "error" })),
        logs: [...current.logs, errorLog],
      }));
      setAgentToast(`[Backend] ${message}`);
      setIsAnalyzing(false);
      setWarRoomOpen(true);
    } finally {
      window.clearTimeout(timeoutId);
      if (analysisAbortRef.current === controller) analysisAbortRef.current = null;
    }
  }, []);

  const submitPrompt = (event?: FormEvent) => {
    event?.preventDefault();
    const query = prompt.trim() || "Describe this scene";
    setPrompt(query);
    if (dateRange.from > dateRange.to) {
      setAnalysisError("The start date must be before the end date.");
      setAgentToast("[Backend] Choose a valid date range before analyzing");
      return;
    }
    const bbox = drawBbox ?? bboxAroundCenter(areaCenter);
    void runBackendAnalysis(query, bbox, dateRange.from, dateRange.to);
  };

  const clearDrawnArea = () => {
    cancelActiveAnalysis();
    setDrawAreaMode(false);
    setIsDrawing(false);
    setDraftBbox(null);
    setDrawBbox(null);
    setSearchBbox(null);
    setSelectedAreaKm2(null);
    setDrawError(null);
    setAreaContext(null);
    setAnalysisReport(null);
    setTimeSeriesResponse(null);
    setAnalysisLogs(null);
    setAnalysisError(null);
    setHighlighted(false);
  };

  const selectSuggestion = (result: NominatimResult) => {
    const latitude = Number(result.lat);
    const longitude = Number(result.lon);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      setSearchError("This result did not include usable coordinates.");
      return;
    }
    setSearchValue(shortPlaceName(result.display_name));
    flyTo([longitude, latitude], searchAreaLabel(result), result.boundingbox);
  };

  const useSelectedArea = () => {
    const bbox = drawBbox ?? bboxAroundCenter(areaCenter);
    setAreaContext({ label: areaContext?.label || "Selected area", area: `${bboxAreaKm2(bbox).toFixed(2)} km²` });
    setAttachmentsOpen(false);
  };

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) setAttachmentName(file.name);
    setAttachmentsOpen(false);
  };

  const handleHighlightChange = (next: boolean) => {
    setHighlighted(next);
    if (next) {
      if (drawBbox) {
        mapRef.current?.fitBounds(
          [[drawBbox[0], drawBbox[1]], [drawBbox[2], drawBbox[3]]],
          { padding: 80, duration: 650, essential: true },
        );
      } else {
        mapRef.current?.flyTo({ center: areaCenter, zoom: 12, essential: true });
      }
    }
  };

  const noImageryError = Boolean(
    analysisError && /no satellite scenes|no usable satellite scenes/i.test(analysisError),
  );

  return (
    <section className="relative w-full h-screen overflow-hidden bg-[#0b1121] text-slate-100 flex">
      <div ref={mapContainerRef} className="absolute inset-0" aria-label="Satellite map" />

      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_48%,transparent_20%,rgba(2,6,23,0.2)_100%)]" />

      <header className="pointer-events-none absolute left-0 right-0 top-0 z-20 flex items-start justify-between p-5">
        <div className="pointer-events-auto flex items-center gap-3 rounded-2xl border border-slate-200/90 bg-white/95 px-4 py-3 text-slate-900 shadow-2xl backdrop-blur-md">
          <div className="grid h-9 w-9 place-items-center rounded-xl bg-blue-50 text-xl text-blue-600">✦</div>
          <div>
            <div className="text-sm font-bold tracking-wide text-slate-900">SatQuery AI</div>
            <div className="mt-0.5 flex items-center gap-2 text-[10px] font-medium uppercase tracking-[0.18em] text-slate-500">
              <StatusDot active={mapReady} />
              {mapReady ? "Live earth intelligence" : "Initializing map"}
            </div>
          </div>
        </div>

        <div className="pointer-events-auto flex items-center gap-2">
          <button
            type="button"
            aria-pressed={drawAreaMode}
            disabled={!mapReady}
            onClick={() => {
              setDrawAreaMode((active) => !active);
              setAttachmentsOpen(false);
            }}
            className={`flex items-center gap-2 rounded-xl border px-4 py-3 text-xs font-semibold shadow-lg backdrop-blur-md transition ${drawAreaMode ? "border-blue-500 bg-blue-600 text-white" : "border-slate-200 bg-white/95 text-slate-900 hover:border-blue-300 hover:bg-blue-50"} disabled:cursor-not-allowed disabled:opacity-50`}
          >
            <span className={drawAreaMode ? "text-blue-100" : "text-blue-600"}>▣</span>
            {drawAreaMode ? "Cancel draw" : "Draw area"}
          </button>
          <button
            type="button"
            onClick={() => setWarRoomOpen(true)}
            className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white/95 px-4 py-3 text-xs font-semibold text-slate-900 shadow-lg backdrop-blur-md transition hover:border-blue-300 hover:bg-blue-50"
          >
            <span className="text-blue-600">◈</span>
            War Room Logs
          </button>
        </div>
      </header>

      <form
        onSubmit={searchLocations}
        className="absolute left-1/2 top-5 z-30 w-[min(440px,calc(100%-340px))] -translate-x-1/2"
      >
        <div className="flex items-center gap-2 rounded-2xl border border-slate-200 bg-white/95 px-3 py-2 text-slate-900 shadow-lg backdrop-blur-md">
          <span className="pl-1 text-slate-500" aria-hidden="true">⌕</span>
          <input
            value={searchValue}
            onChange={(event) => {
              setSearchValue(event.target.value);
              setSearchError(null);
            }}
            placeholder="Search a place or enter lat, lon"
            className="min-w-0 flex-1 bg-transparent px-1 py-1 text-sm font-medium text-slate-900 outline-none placeholder:text-slate-400"
            aria-label="Search a place or coordinates"
          />
          {searching && <span className="text-[10px] font-medium uppercase tracking-wider text-slate-500">Searching</span>}
          <button
            type="submit"
            className="rounded-xl bg-blue-600 px-3 py-2 text-xs font-semibold text-white transition hover:bg-blue-700"
          >
            Go
          </button>
        </div>
        {(suggestions.length > 0 || searchError) && (
          <div className="mt-2 overflow-hidden rounded-2xl border border-slate-200/90 bg-white/95 text-slate-900 shadow-2xl backdrop-blur-md">
            {suggestions.map((result) => (
              <div key={result.place_id} className="flex items-center gap-3 border-b border-slate-200 px-3 py-3 last:border-0">
                <button
                  type="button"
                  onClick={() => selectSuggestion(result)}
                  className="min-w-0 flex-1 text-left transition hover:text-blue-700"
                >
                  <div className="truncate text-xs font-bold text-slate-900">{shortPlaceName(result.display_name)}</div>
                  <div className="mt-1 truncate text-[10px] text-slate-500">{result.display_name}</div>
                </button>
                <button
                  type="button"
                  onClick={() => selectSuggestion(result)}
                  className="shrink-0 rounded-lg border border-blue-200 bg-blue-50 px-2 py-1.5 text-[10px] font-semibold text-blue-700 hover:bg-blue-100"
                >
                  Use as area
                </button>
              </div>
            ))}
            {searchError && <div className="px-4 py-3 text-xs font-medium text-rose-600">{searchError}</div>}
          </div>
        )}
      </form>

      {(drawAreaMode || drawError) && (
        <div className={`absolute left-1/2 top-24 z-20 -translate-x-1/2 rounded-xl border px-4 py-2.5 text-center text-[10px] font-semibold shadow-xl backdrop-blur-md ${drawError ? "border-rose-200 bg-rose-50/95 text-rose-700" : "border-blue-200 bg-blue-50/95 text-blue-800"}`}>
          {drawError || (isDrawing ? "Release the mouse to finalize the selected bbox." : "Drag on the map to draw an analysis bounding box.")}
        </div>
      )}

      <div className="absolute bottom-5 left-5 z-10 hidden rounded-xl border border-slate-200/90 bg-white/95 px-3 py-2 text-[10px] font-medium uppercase tracking-[0.16em] text-slate-500 shadow-lg backdrop-blur-md md:block">
        <span className="mr-2 text-blue-600">◉</span>
        {projection === "globe" ? "3D globe" : "2D mercator"} · zoom threshold 7
      </div>

      {basemapError && (
        <div className="absolute left-1/2 top-28 z-20 -translate-x-1/2 rounded-xl border border-slate-200/90 bg-white/95 px-4 py-3 text-center text-xs text-slate-900 shadow-2xl backdrop-blur-md">
          <div className="font-bold">Basemap unavailable</div>
          <div className="mt-1 max-w-xs text-[10px] text-slate-500">Analysis controls remain available. Check the map connection to restore tiles.</div>
        </div>
      )}

      {highlighted && analysisReport && (
        <div className="absolute left-1/2 top-28 z-20 -translate-x-1/2 rounded-xl border border-blue-200 bg-blue-50/95 px-4 py-2.5 text-center text-[10px] font-semibold text-blue-800 shadow-xl backdrop-blur-md">
          <span className="mr-1.5 text-blue-600">◎</span>Analysis extent highlighted on map
        </div>
      )}

      <aside className="absolute bottom-28 right-5 top-24 z-20 flex w-[min(330px,calc(100%-40px))] flex-col overflow-hidden rounded-2xl border border-slate-200/90 bg-white/95 text-slate-900 shadow-2xl backdrop-blur-md lg:w-[342px]">
        {analysisError && !isAnalyzing ? (
          <div className="flex flex-1 flex-col justify-center px-5 py-6">
            <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-4 text-rose-900">
              <div className="text-[10px] font-bold uppercase tracking-[0.2em] text-rose-600">{noImageryError ? "No imagery available" : "Analysis unavailable"}</div>
              <h2 className="mt-2 text-sm font-bold text-rose-950">{noImageryError ? "No usable scene for this selection" : "Could not load the time series"}</h2>
              <p className="mt-2 text-[11px] leading-5 text-rose-800">{analysisError}</p>
            </div>
            <button
              type="button"
              onClick={() => submitPrompt()}
              className="mt-3 rounded-xl border border-blue-200 bg-blue-50 px-3 py-2.5 text-[11px] font-semibold text-blue-800 transition hover:bg-blue-100"
            >
              Try again
            </button>
          </div>
        ) : analysisReport && !isAnalyzing ? (
          <AnalysisReport
            report={analysisReport}
            highlighted={highlighted}
            onHighlightChange={handleHighlightChange}
          />
        ) : (
          <>
            <div className="border-b border-slate-200 px-5 py-4">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-[10px] font-medium uppercase tracking-[0.2em] text-blue-600">Scene intelligence</div>
                  <h2 className="mt-1 text-base font-bold text-slate-900">Agent execution plan</h2>
                </div>
                <span className={`rounded-full px-2 py-1 text-[10px] font-semibold ${isAnalyzing ? "bg-blue-50 text-blue-700" : "bg-emerald-50 text-emerald-600"}`}>{isAnalyzing ? "Running" : "Ready"}</span>
              </div>
              <div className="mt-4 flex items-center justify-between text-[11px] font-medium text-slate-700">
                <span>{areaContext?.label || "Pune, Maharashtra"}</span>
                <span className="text-slate-500">{agentLoop.nodes.length} local agents</span>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto px-5 py-4">
              <div role="status" className="mb-5 rounded-xl border border-blue-200 bg-blue-50 px-3 py-2.5 text-[10px] font-semibold leading-4 text-blue-800 shadow-sm">
                <span className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full bg-blue-600 motion-safe:animate-pulse" aria-hidden="true" />
                {agentToast}
              </div>
              <div className="border-t border-slate-200 pt-5">
                <div className="mb-3 flex items-center justify-between">
                  <h3 className="text-xs font-bold text-slate-900">Agent execution</h3>
                  <span className="font-mono text-[10px] text-slate-500">{formatTimestamp()}</span>
                </div>
                <div className="space-y-0">
                  {analysisSteps.map((step, index) => (
                    <div key={step.id} className="relative flex gap-3 pb-4 last:pb-0">
                      {index < analysisSteps.length - 1 && <span className="absolute left-[9px] top-5 h-full w-px bg-slate-200" />}
                      <div className={`relative z-10 grid h-5 w-5 shrink-0 place-items-center rounded-full border text-[10px] ${step.status === "done" ? "border-emerald-500 bg-emerald-500 text-white" : step.status === "running" ? "border-blue-600 bg-blue-600 text-white" : "border-slate-300 bg-slate-100 text-slate-500"}`}>
                        {step.status === "done" ? "✓" : step.status === "running" ? "•" : "·"}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className={`text-[11px] font-medium ${step.status === "pending" ? "text-slate-400" : "text-slate-700"}`}>{step.label}</div>
                        <div className="mt-0.5 truncate text-[10px] text-slate-500">{step.detail}</div>
                      </div>
                      <div className={`font-mono text-[10px] ${step.status === "pending" ? "text-slate-400" : "text-slate-500"}`}>{step.milliseconds} ms</div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </>
        )}
      </aside>

      <div className="absolute bottom-5 left-1/2 z-30 w-[min(690px,calc(100%-40px))] -translate-x-1/2">
        {datesOpen && (
          <div className="mb-2 ml-auto flex w-fit items-center gap-2 rounded-xl border border-slate-200/90 bg-white/95 p-2 text-slate-900 shadow-2xl backdrop-blur-md">
            <label className="text-[10px] font-medium uppercase tracking-wider text-slate-500">From <input type="date" value={dateRange.from} onChange={(event) => setDateRange((current) => ({ ...current, from: event.target.value }))} className="ml-1 rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs font-medium text-slate-900" /></label>
            <span className="text-slate-600">→</span>
            <label className="text-[10px] font-medium uppercase tracking-wider text-slate-500">To <input type="date" value={dateRange.to} onChange={(event) => setDateRange((current) => ({ ...current, to: event.target.value }))} className="ml-1 rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs font-medium text-slate-900" /></label>
          </div>
        )}
        <form onSubmit={submitPrompt} className="rounded-2xl border-2 border-blue-500/80 bg-white/95 p-2 text-slate-900 shadow-2xl backdrop-blur-lg">
          <div className="flex items-center gap-2">
            <div className="relative">
              <button type="button" onClick={() => setAttachmentsOpen((open) => !open)} className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-blue-50 text-xl text-blue-700 transition hover:bg-blue-100" aria-label="Add analysis context">+</button>
              {attachmentsOpen && (
                <div className="absolute bottom-12 left-0 w-52 overflow-hidden rounded-xl border border-slate-200/90 bg-white/95 text-slate-900 shadow-2xl backdrop-blur-md">
                  <button type="button" onClick={() => fileInputRef.current?.click()} className="block w-full px-3 py-2.5 text-left text-xs font-medium text-slate-700 hover:bg-blue-50 hover:text-blue-700">↥ Upload GeoTIFF / PNG</button>
                  <button type="button" onClick={useSelectedArea} className="block w-full px-3 py-2.5 text-left text-xs font-medium text-slate-700 hover:bg-blue-50 hover:text-blue-700">⌖ Select area</button>
                  <button type="button" onClick={() => { setDatesOpen((open) => !open); setAttachmentsOpen(false); }} className="block w-full px-3 py-2.5 text-left text-xs font-medium text-slate-700 hover:bg-blue-50 hover:text-blue-700">◷ Choose dates</button>
                </div>
              )}
              <input ref={fileInputRef} type="file" accept=".tif,.tiff,.png,image/png" onChange={handleFileChange} className="hidden" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-1.5">
                {drawBbox && (
                  <span className="flex max-w-full items-center gap-1 rounded-md border border-blue-300 bg-blue-50 px-2 py-1 text-[10px] font-semibold text-blue-800" title={`[${formatBbox(drawBbox)}]`}>
                    <span className="truncate">⌖ {searchBbox && areaContext ? areaContext.label : `Selected Area (${(selectedAreaKm2 ?? bboxAreaKm2(drawBbox)).toFixed(2)} km²)`}</span>
                    <button type="button" onClick={clearDrawnArea} className="ml-0.5 rounded px-1 text-blue-600 hover:bg-blue-100 hover:text-blue-900" aria-label="Clear selected bounding box">×</button>
                  </span>
                )}
                {!drawBbox && areaContext && <span className="rounded-md border border-blue-200 bg-blue-50 px-2 py-1 text-[10px] font-semibold text-blue-700">⌖ {areaContext.label} · {areaContext.area}</span>}
                {dateRange.from && dateRange.to && <span className="rounded-md border border-blue-200 bg-blue-50 px-2 py-1 font-mono text-[10px] font-semibold text-blue-700">◷ {dateRange.from} → {dateRange.to}</span>}
                {attachmentName && <span className="max-w-40 truncate rounded-md border border-blue-200 bg-blue-50 px-2 py-1 text-[10px] font-semibold text-blue-700">↥ {attachmentName}</span>}
              </div>
              <input value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder={drawBbox ? "Ask a question about the selected box..." : "Ask SatQuery AI about this scene..."} className="mt-1 w-full bg-transparent px-1 py-1 text-sm font-medium text-slate-900 outline-none placeholder:text-slate-400" aria-label={drawBbox ? "Ask about selected bounding box" : "Ask SatQuery AI"} />
            </div>
            <button type="submit" disabled={isAnalyzing} className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-blue-600 text-lg font-bold text-white transition hover:bg-blue-700 disabled:cursor-wait disabled:opacity-50" aria-label="Run analysis">{isAnalyzing ? "…" : "↑"}</button>
          </div>
        </form>
        <div className="mt-2 flex flex-wrap justify-center gap-2">
          {["What land cover is here?", "Describe this scene", "Highlight built-up area"].map((suggestion) => (
            <button key={suggestion} type="button" onClick={() => setPrompt(suggestion)} className="rounded-full bg-slate-900 px-3 py-1.5 text-[10px] font-semibold text-white shadow-md transition hover:bg-slate-800">{suggestion}</button>
          ))}
        </div>
      </div>

      <AgentWarRoomModal
        open={warRoomOpen}
        onClose={() => setWarRoomOpen(false)}
        context={{
          route: agentLoop.isComplex ? "SatQuery AI v2 controller" : "Backend controller",
          query: prompt || "Describe this scene",
          status: isAnalyzing ? "running" : analysisError ? "error" : analysisReport ? "complete" : "ready",
        }}
        loopState={agentLoop}
        trace={timeSeriesResponse?.trace}
        analysisLogs={analysisLogs ?? undefined}
      />
    </section>
  );
}
