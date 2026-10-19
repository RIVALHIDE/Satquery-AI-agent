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
} from "maplibre-gl";
import AgentWarRoomModal from "../components/AgentWarRoomModal";
import type {
  AnalysisStep,
  AreaContext,
  DateRange,
  Measurement,
} from "../types";

const DEFAULT_MAP_STYLE = "https://tiles.openfreemap.org/styles/bright";
const INITIAL_CENTER: [number, number] = [73.8567, 18.5204];
const INITIAL_ZOOM = 2;
const PROJECTION_THRESHOLD = 7;

type ProjectionName = "globe" | "mercator";

interface NominatimResult {
  place_id: number;
  display_name: string;
  lat: string;
  lon: string;
  type: string;
}

const measurements: Measurement[] = [
  { label: "Vegetation", value: "41.8%", color: "bg-emerald-500", percentage: 41.8 },
  { label: "Water", value: "18.6%", color: "bg-cyan-600", percentage: 18.6 },
  { label: "Built-up", value: "24.1%", color: "bg-amber-500", percentage: 24.1 },
  { label: "Bare Soil", value: "12.3%", color: "bg-orange-500", percentage: 12.3 },
  { label: "Cloud", value: "3.2%", color: "bg-slate-500", percentage: 3.2 },
];

const stepTemplates: AnalysisStep[] = [
  {
    id: "router",
    label: "Orchestrator classified intent",
    detail: "Feature extraction route selected",
    milliseconds: 12,
    status: "done",
  },
  {
    id: "fetch",
    label: "Loaded Sentinel-2 scene",
    detail: "Optical bands B02 / B03 / B04 / B08",
    milliseconds: 184,
    status: "done",
  },
  {
    id: "segment",
    label: "Feature Extraction Agent",
    detail: "HSV segmentation and pixel sampling",
    milliseconds: 476,
    status: "done",
  },
  {
    id: "measure",
    label: "Computed land-cover breakdown",
    detail: "5 classes · 2.4M pixels analyzed",
    milliseconds: 692,
    status: "done",
  },
];

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

function formatTimestamp(date = new Date()): string {
  return date.toISOString().slice(11, 23);
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
  styleUrl?: string;
}) {
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const mapReadyRef = useRef(false);
  const projectionRef = useRef<ProjectionName>("globe");
  const searchAbortRef = useRef<AbortController | null>(null);
  const timerRefs = useRef<number[]>([]);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [mapReady, setMapReady] = useState(false);
  const [mapError, setMapError] = useState<string | null>(null);
  const [projection, setProjection] = useState<ProjectionName>("globe");
  const [searchValue, setSearchValue] = useState("");
  const [suggestions, setSuggestions] = useState<NominatimResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [areaContext, setAreaContext] = useState<AreaContext | null>(null);
  const [dateRange, setDateRange] = useState<DateRange>({
    from: "2025-10-18",
    to: "2026-09-18",
  });
  const [datesOpen, setDatesOpen] = useState(false);
  const [attachmentsOpen, setAttachmentsOpen] = useState(false);
  const [attachmentName, setAttachmentName] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [analysisSteps, setAnalysisSteps] = useState<AnalysisStep[]>(stepTemplates);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [warRoomOpen, setWarRoomOpen] = useState(false);

  useEffect(() => {
    const container = mapContainerRef.current;
    if (!container || mapRef.current) return;

    let map: MapLibreMap | null = null;
    const handleZoom = () => {
      if (!map) return;
      const nextProjection: ProjectionName =
        map.getZoom() >= PROJECTION_THRESHOLD ? "mercator" : "globe";
      if (nextProjection === projectionRef.current) return;

      try {
        map.setProjection(projectionFor(nextProjection));
        projectionRef.current = nextProjection;
        setProjection(nextProjection);
      } catch (error) {
        setMapError(error instanceof Error ? error.message : "Projection transition failed.");
      }
    };
    const handleMapLoad = () => {
      mapReadyRef.current = true;
      setMapReady(true);
      setMapError(null);
    };
    const handleMapIdle = () => {
      // A style can finish loading before all vector/raster tiles arrive. The
      // idle event is the safe point at which the visible basemap is ready.
      if (map?.isStyleLoaded()) setMapError(null);
    };
    const handleMapError = (event: maplibregl.ErrorEvent) => {
      const message = event.error?.message || "The basemap could not be loaded.";

      // Tile 404s/timeouts can be emitted while MapLibre is still assembling
      // the style. They should not cover the working UI with a fatal banner;
      // the next successful tile/idle event clears any transient warning.
      const isTileError = /tile|source|vector|raster|glyph|sprite/i.test(message);
      if (isTileError && (mapReadyRef.current || map?.isStyleLoaded())) {
        setMapError(null);
        return;
      }
      setMapError(message);
    };

    try {
      // MapLibre exposes projection changes through setProjection in the
      // installed version. Keep the initial projection in the options object
      // as well so the intent is explicit, then apply it immediately.
      const mapOptions = {
        container,
        style: styleUrl,
        center: INITIAL_CENTER,
        zoom: INITIAL_ZOOM,
        pitch: 18,
        projection: projectionFor("globe"),
      } as MapOptions & { projection: ProjectionSpecification };
      map = new maplibregl.Map(mapOptions);
      map.setProjection(projectionFor("globe"));
      mapRef.current = map;
      map.addControl(new NavigationControl({ showCompass: true }), "bottom-right");
      map.on("zoom", handleZoom);
      map.on("error", handleMapError);
      map.once("load", handleMapLoad);
      map.on("idle", handleMapIdle);
    } catch (error) {
      setMapError(error instanceof Error ? error.message : "Unable to initialize the map.");
    }

    return () => {
      if (map) {
        map.off("zoom", handleZoom);
        map.off("error", handleMapError);
        map.off("idle", handleMapIdle);
        map.remove();
      }
      mapReadyRef.current = false;
      mapRef.current = null;
      setMapReady(false);
    };
  }, [styleUrl]);

  useEffect(() => {
    return () => {
      searchAbortRef.current?.abort();
      timerRefs.current.forEach((timer) => window.clearTimeout(timer));
    };
  }, []);

  const flyTo = useCallback((center: [number, number], label?: string) => {
    mapRef.current?.flyTo({ center, zoom: 12, essential: true });
    if (label) {
      setAreaContext({ label, area: "1.18 km²" });
    }
    setSuggestions([]);
    setSearchError(null);
  }, []);

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
        setSuggestions(results);
        if (results.length === 0) setSearchError("No locations matched that search.");
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

  const runAnalysis = useCallback(() => {
    timerRefs.current.forEach((timer) => window.clearTimeout(timer));
    setIsAnalyzing(true);
    setAnalysisSteps(
      stepTemplates.map((step, index) => ({
        ...step,
        milliseconds: index === 0 ? 0 : step.milliseconds,
        status: index === 0 ? "running" : "pending",
      })),
    );

    const timers: number[] = [];
    stepTemplates.forEach((step, index) => {
      timers.push(
        window.setTimeout(() => {
          setAnalysisSteps((current) =>
            current.map((currentStep, currentIndex) => ({
              ...currentStep,
              status:
                currentIndex < index
                  ? "done"
                  : currentIndex === index
                    ? "running"
                    : "pending",
              milliseconds: currentIndex <= index ? stepTemplates[currentIndex].milliseconds : currentStep.milliseconds,
            })),
          );
        }, index * 520),
      );
    });
    timers.push(
      window.setTimeout(() => {
        setAnalysisSteps((current) => current.map((step) => ({ ...step, status: "done" })));
        setIsAnalyzing(false);
      }, stepTemplates.length * 520),
    );
    timerRefs.current = timers;
  }, []);

  const submitPrompt = (event?: FormEvent) => {
    event?.preventDefault();
    if (!prompt.trim() && !isAnalyzing) {
      setPrompt("Describe this scene");
    }
    runAnalysis();
  };

  const selectSuggestion = (result: NominatimResult) => {
    const latitude = Number(result.lat);
    const longitude = Number(result.lon);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      setSearchError("This result did not include usable coordinates.");
      return;
    }
    setSearchValue(shortPlaceName(result.display_name));
    flyTo([longitude, latitude], shortPlaceName(result.display_name));
  };

  const useSelectedArea = () => {
    setAreaContext({ label: areaContext?.label || "Selected area", area: "1.18 km²" });
    setAttachmentsOpen(false);
  };

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) setAttachmentName(file.name);
    setAttachmentsOpen(false);
  };

  return (
    <section className="relative h-full w-full overflow-hidden bg-[#07111b]">
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

        <button
          type="button"
          onClick={() => setWarRoomOpen(true)}
          className="pointer-events-auto flex items-center gap-2 rounded-xl border border-slate-200 bg-white/95 px-4 py-3 text-xs font-semibold text-slate-900 shadow-lg backdrop-blur-md transition hover:border-blue-300 hover:bg-blue-50"
        >
          <span className="text-blue-600">◈</span>
          War Room Logs
        </button>
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

      <div className="absolute bottom-5 left-5 z-10 hidden rounded-xl border border-slate-200/90 bg-white/95 px-3 py-2 text-[10px] font-medium uppercase tracking-[0.16em] text-slate-500 shadow-lg backdrop-blur-md md:block">
        <span className="mr-2 text-blue-600">◉</span>
        {projection === "globe" ? "3D globe" : "2D mercator"} · zoom threshold 7
      </div>

      {mapError && (
        <div className="absolute left-1/2 top-28 z-20 -translate-x-1/2 rounded-xl border border-slate-200/90 bg-white/95 px-4 py-3 text-center text-xs text-slate-900 shadow-2xl backdrop-blur-md">
          <div className="font-bold">Basemap unavailable</div>
          <div className="mt-1 max-w-xs text-[10px] text-slate-500">Analysis controls remain available. Check the map connection to restore tiles.</div>
        </div>
      )}

      <aside className="absolute bottom-28 right-5 top-24 z-20 flex w-[min(330px,calc(100%-40px))] flex-col overflow-hidden rounded-2xl border border-slate-200/90 bg-white/95 text-slate-900 shadow-2xl backdrop-blur-md lg:w-[342px]">
        <div className="border-b border-slate-200 px-5 py-4">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-[10px] font-medium uppercase tracking-[0.2em] text-blue-600">Scene intelligence</div>
              <h2 className="mt-1 text-base font-bold text-slate-900">Land cover analysis</h2>
            </div>
            <span className="rounded-full bg-emerald-50 px-2 py-1 text-[10px] font-semibold text-emerald-600">{isAnalyzing ? "Running" : "Ready"}</span>
          </div>
          <div className="mt-4 flex items-center justify-between text-[11px] font-medium text-slate-700">
            <span>{areaContext?.label || "Pune, Maharashtra"}</span>
            <span className="text-slate-500">Sentinel-2 L2A</span>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          <div className="mb-5">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-xs font-bold text-slate-900">Measurement breakdown</h3>
              <span className="text-[10px] text-slate-500">Latest scene</span>
            </div>
            <div className="space-y-3">
              {measurements.map((measurement) => (
                <div key={measurement.label}>
                  <div className="mb-1.5 flex items-center justify-between text-[11px]">
                    <span className="flex items-center gap-2 font-medium text-slate-700"><span className={`h-2 w-2 rounded-full ${measurement.color}`} />{measurement.label}</span>
                    <span className="font-mono font-semibold text-slate-900">{measurement.value}</span>
                  </div>
                  <div className="h-1 overflow-hidden rounded-full bg-slate-200">
                    <div className={`h-full rounded-full ${measurement.color}`} style={{ width: `${measurement.percentage}%` }} />
                  </div>
                </div>
              ))}
            </div>
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
                {areaContext && <span className="rounded-md border border-blue-200 bg-blue-50 px-2 py-1 text-[10px] font-semibold text-blue-700">⌖ {areaContext.label} · {areaContext.area}</span>}
                {dateRange.from && dateRange.to && <span className="rounded-md border border-blue-200 bg-blue-50 px-2 py-1 font-mono text-[10px] font-semibold text-blue-700">◷ {dateRange.from} → {dateRange.to}</span>}
                {attachmentName && <span className="max-w-40 truncate rounded-md border border-blue-200 bg-blue-50 px-2 py-1 text-[10px] font-semibold text-blue-700">↥ {attachmentName}</span>}
              </div>
              <input value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="Ask SatQuery AI about this scene..." className="mt-1 w-full bg-transparent px-1 py-1 text-sm font-medium text-slate-900 outline-none placeholder:text-slate-400" aria-label="Ask SatQuery AI" />
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

      <AgentWarRoomModal open={warRoomOpen} onClose={() => setWarRoomOpen(false)} context={{ route: "Feature Extraction Agent", query: prompt || "Describe this scene", status: isAnalyzing ? "running" : "complete" }} />
    </section>
  );
}
