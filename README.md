# SatQuery-Agent

https://youtu.be/7omqHjBwN2M?feature=shared

Agentic satellite vision-language query assistant for ** Frontier Buildathon**.
https://youtu.be/7omqHjBwN2M?feature=shared

Agentic satellite vision-language query assistant for ** Frontier Buildathon**.

Draw a bounding box on the interactive globe, ask a natural-language question, and the agent fetches real Sentinel-2 optical or Sentinel-1 SAR scenes from Microsoft Planetary Computer, runs deterministic computer-vision tools locally, and returns a structured executive report with a monthly timeline, land-cover metrics, and change detection.

---

## What the project does

1. **User draws a bbox on the MapLibre globe** and types a question such as *"What changed here over the last year?"*
2. The **React frontend** sends the bbox, date range, and query to the FastAPI backend.
3. The **Acquisition Pipeline** searches the Planetary Computer STAC catalog, picks the lowest-cloud-cover scene per calendar month, and reads raster bands with Rasterio. When cloud cover exceeds 60 % it automatically falls back to Sentinel-1 RTC SAR data.
4. The **Analysis Controller** runs a deterministic DAG:
   - geodesic area calculation (Shapely + pyproj)
   - NDVI and NDWI indices (NIR / red / green bands)
   - SAR backscatter metrics (VV / VH polarisation)
   - SSIM + Otsu change detection between consecutive months
5. Every step is recorded as a **TraceStep** and streamed to the **Agent War Room** modal.
6. The **AnalysisReport** component renders the executive summary, monthly thumbnail timeline, land-cover bars, key findings, and export buttons (PDF, GeoJSON, JSON, text).

---
Draw a bounding box on the interactive globe, ask a natural-language question, and the agent fetches real Sentinel-2 optical or Sentinel-1 SAR scenes from Microsoft Planetary Computer, runs deterministic computer-vision tools locally, and returns a structured executive report with a monthly timeline, land-cover metrics, and change detection.

---

## What the project does

1. **User draws a bbox on the MapLibre globe** and types a question such as *"What changed here over the last year?"*
2. The **React frontend** sends the bbox, date range, and query to the FastAPI backend.
3. The **Acquisition Pipeline** searches the Planetary Computer STAC catalog, picks the lowest-cloud-cover scene per calendar month, and reads raster bands with Rasterio. When cloud cover exceeds 60 % it automatically falls back to Sentinel-1 RTC SAR data.
4. The **Analysis Controller** runs a deterministic DAG:
   - geodesic area calculation (Shapely + pyproj)
   - NDVI and NDWI indices (NIR / red / green bands)
   - SAR backscatter metrics (VV / VH polarisation)
   - SSIM + Otsu change detection between consecutive months
5. Every step is recorded as a **TraceStep** and streamed to the **Agent War Room** modal.
6. The **AnalysisReport** component renders the executive summary, monthly thumbnail timeline, land-cover bars, key findings, and export buttons (PDF, GeoJSON, JSON, text).

---

## Architecture

```
User draws bbox + types query
           │
           ▼
    React MapView (MapLibre GL)
    bbox draw · Nominatim search
    date range picker · prompt bar
           │  POST /imagery/analyze or /analyze
           ▼
    FastAPI backend  (backend/api.py)
    CORS · /health · /analyze · /imagery/analyze
           │
           ▼
    AnalysisController  (backend/agent/controller.py)
    Planner DAG → Validator → Tool Registry → Summarizer
           │
     ┌─────┴──────┐
     ▼            ▼
Sentinel-2    Sentinel-1 RTC
optical       SAR fallback
(Planetary Computer STAC)
     │            │
     └─────┬──────┘
           ▼
    Tools (tools/)
    ├── geo.area      (Shapely + pyproj geodesic area)
    ├── geo.indices   (NDVI, NDWI — numpy, no LLM)
    └── change.detect (SSIM + Otsu — scikit-image + OpenCV)
           │
           ▼
    V2AnalysisResponse / AnalysisResult
    status · confidence · metrics · months[]
    trace[] · thumbnail_b64 · analysis_logs[]
           │
           ▼
    React AnalysisReport + AgentWarRoomModal
```

The original offline `satquery/` package (keyword router + HSV tools) is preserved for local demos and the Streamlit UI.

---
```
User draws bbox + types query
           │
           ▼
    React MapView (MapLibre GL)
    bbox draw · Nominatim search
    date range picker · prompt bar
           │  POST /imagery/analyze or /analyze
           ▼
    FastAPI backend  (backend/api.py)
    CORS · /health · /analyze · /imagery/analyze
           │
           ▼
    AnalysisController  (backend/agent/controller.py)
    Planner DAG → Validator → Tool Registry → Summarizer
           │
     ┌─────┴──────┐
     ▼            ▼
Sentinel-2    Sentinel-1 RTC
optical       SAR fallback
(Planetary Computer STAC)
     │            │
     └─────┬──────┘
            ▼
     Tools (backend/tools/)
    ├── geo.area      (Shapely + pyproj geodesic area)
    ├── geo.indices   (NDVI, NDWI — numpy, no LLM)
    └── change.detect (SSIM + Otsu — scikit-image + OpenCV)
           │
           ▼
    V2AnalysisResponse / AnalysisResult
     status · confidence · metrics · months[]
     trace[] · answer · summary
           │
           ▼
    React AnalysisReport + AgentWarRoomModal
```

The legacy keyword router, canned image API, and HSV-only tools have been removed. The frontend and Streamlit client now use the v2 controller contract.

---

## Repository layout

```
.
├── acquisition/               # STAC search, raster I/O, error types
│   ├── stac.py                # Sentinel2Fetcher, Sentinel1RTCFetcher, AcquisitionPipeline
│   ├── raster.py              # safe_read_raster (Rasterio + NaN sanitization)
│   ├── clipping.py
│   └── errors.py              # AcquisitionError, NoScenesError, AssetValidationError
├── agent/                     # Deterministic orchestration layer
│   ├── controller.py          # AnalysisController — full DAG execution
│   ├── planner.py             # DAGPlanner — builds ExecutionPlan from scenes
│   └── validator.py           # SceneValidator — CRS, extent, band checks
├── backend/                   # FastAPI app and its own mirrored modules
│   ├── api.py                 # /health · /analyze · /imagery/analyze (CORS enabled)
│   ├── agent/controller.py    # backend-scoped controller (trace-backed)
│   ├── models/contracts.py    # InputConfig, Asset, TraceStep, MonthlyResult, AnalysisResult
│   └── tools/
│       ├── change/index.py    # detect_change (SSIM + Otsu)
│       └── geo/indices.py     # calculate_indices (NDVI, NDWI)
├── models/
│   └── schemas.py             # BBoxQuery, TraceStep, MonthlyResult, V2AnalysisResponse
├── tools/                     # Pure analysis functions (no FastAPI dependency)
│   ├── area.py                # calculate_geodesic_area
│   ├── change.py              # detect_change (SSIM + Otsu thresholding)
│   ├── indices.py             # compute_ndvi, compute_ndwi, calculate_indices
│   └── registry.py            # ToolRegistry — explicit named-tool execution
├── satquery/                  # Original offline v1 package (preserved)
│   ├── api.py                 # POST /query (multipart images)
│   ├── models.py              # Intent, AgentResponse, ToolResult, BoundingBox
│   ├── router.py              # OrchestratorRouterAgent + KeywordIntentClassifier
│   ├── service.py             # analyze_query — decodes bytes, calls router
│   └── tools.py               # BiTemporalChangeDetectionTool, FeatureExtractionTool
```
.
├── backend/                   # The only application backend
│   ├── api.py                 # /health · /analyze · /imagery/analyze (CORS enabled)
│   ├── models/contracts.py    # InputConfig, Asset, TraceStep, AnalysisResult
│   ├── acquisition/           # STAC search, SAR fallback, raster clipping
│   ├── agent/                 # classifier, planner, validator, controller
│   └── tools/                 # registry, area, NDVI/NDWI, SSIM/Otsu
├── satquery/api.py            # compatibility import of backend.api
├── frontend/
│   ├── streamlit_app.py       # Streamlit demo (calls satquery.service directly)
│   └── src/
│       ├── map/MapView.tsx    # Globe, bbox draw, search, prompt bar, analysis state
│       ├── components/
│       │   ├── AgentWarRoomModal.tsx   # Phase rail, agent cards, live terminal logs
│       │   └── AnalysisReport.tsx     # Executive report, timeline, export buttons
│       └── types.ts           # Shared TS interfaces
│   ├── streamlit_app.py       # Streamlit client (calls the v2 controller)
│   └── src/
│       ├── map/MapView.tsx    # Globe, bbox draw, search, prompt bar, analysis state
│       ├── components/
│       │   ├── AgentWarRoomModal.tsx   # Phase rail, agent cards, live terminal logs
│       │   └── AnalysisReport.tsx     # Executive report, timeline, export buttons
│       └── types.ts           # Shared TS interfaces
├── tests/
│   └── test_backend.py        # Controller, tools, API integration tests
├── docs/
│   └── subagent-orchestration.md   # Full agent loop walkthrough
├── demo/
│   └── images/                # Deterministic test fixtures
│   └── test_backend.py        # Controller, tools, API integration tests
├── demo/
│   └── images/                # Deterministic test fixtures
├── Dockerfile
├── Makefile
├── requirements.txt
└── .python-version            # Python 3.11
```

---

## Satellite data sources

| Source | Collection | Bands | Use case |
|---|---|---|---|
| Microsoft Planetary Computer | `sentinel-2-l2a` | B02 B03 B04 B08 | Optical RGB + NIR → NDVI / NDWI |
| Microsoft Planetary Computer | `sentinel-1-rtc` | VV VH | SAR — cloud-penetrating radar, floods, damage |

The pipeline automatically switches to SAR when optical cloud cover exceeds 60 % and `satellite` is set to `"auto"` (the default). You can force a specific sensor by setting `satellite` to `"sentinel-2"` or `"sentinel-1-rtc"` in the request body.

No API key or account is required for Planetary Computer.

---
└── .python-version            # Python 3.11
```

---

## Satellite data sources

| Source | Collection | Bands | Use case |
|---|---|---|---|
| Microsoft Planetary Computer | `sentinel-2-l2a` | B02 B03 B04 B08 | Optical RGB + NIR → NDVI / NDWI |
| Microsoft Planetary Computer | `sentinel-1-rtc` | VV VH | SAR — cloud-penetrating radar, floods, damage |

The pipeline automatically switches to SAR when optical cloud cover exceeds 60 % and `satellite` is set to `"auto"` (the default). You can force a specific sensor by setting `satellite` to `"sentinel-2"` or `"sentinel-1-rtc"` in the request body.

No API key or account is required for Planetary Computer.

---

## Local setup

Python 3.11 is required.
Python 3.11 is required.

```bash
# install venv module if missing (Debian/Ubuntu)
sudo apt install python3.11-venv

# install venv module if missing (Debian/Ubuntu)
sudo apt install python3.11-venv

python3.11 -m venv .venv
source .venv/bin/activate
pip install --upgrade pip
pip install --no-cache-dir -r requirements.txt
source .venv/bin/activate
pip install --upgrade pip
pip install --no-cache-dir -r requirements.txt
```

Copy `.env.example` to `.env` if you want to customise optional settings. The application needs no secrets or API keys.

---

## Run

### Backend (v2 — real satellite data)

```bash
source .venv/bin/activate
python -m uvicorn backend.api:app --host 0.0.0.0 --port 8000
```

Health check:

```bash
curl http://localhost:8000/health
# {"status":"ok","mode":"v2-backend"}
```

### React frontend

```bash
cd frontend
npm ci
npm run dev
```

Open `http://localhost:5173`. Draw a bounding box on the globe, pick a date range, type a question, and press **Analyze**.

```bash
# production checks
npm run typecheck
npm run build
```

### v1 offline backend (keyword router + uploaded images)
Copy `.env.example` to `.env` if you want to customise optional settings. The application needs no secrets or API keys.

---

## Run

### Backend (v2 — real satellite data)

```bash
source .venv/bin/activate
make api        # uvicorn satquery.api:app --port 8000
python -m uvicorn backend.api:app --host 0.0.0.0 --port 8000
```

### Streamlit demo (v1 offline)
Health check:

```bash
source .venv/bin/activate
make frontend   # streamlit run frontend/streamlit_app.py
```

---

## API reference

### v2 backend

#### `GET /health`
```json
{"status": "ok", "mode": "v2-backend"}
```

#### `POST /analyze` and `POST /imagery/analyze`

Both routes accept the same JSON body and return the same response. `/imagery/analyze` is a compatibility alias for the React frontend.

**Request body:**
```json
{
  "bbox": [73.7, 18.4, 73.9, 18.6],
  "query": "What changed here over the last year?",
  "start_date": "2024-01",
  "end_date": "2024-12",
  "satellite": "auto"
}
```

`satellite` accepts `"auto"` (default), `"sentinel-2"`, or `"sentinel-1-rtc"`.  
Dates accept `"YYYY-MM"` or `"YYYY-MM-DD"`.

**Response shape:**
```json
{
  "status": "ok",
  "query": "What changed here over the last year?",
  "bbox": [73.7, 18.4, 73.9, 18.6],
  "confidence": 0.87,
  "metrics": {
    "area_hectares": 412.5,
    "ndvi_mean": 0.38,
    "ndvi_vegetation_percentage": 54.2,
    "ndwi_water_percentage": 8.1,
    "changed_area_percentage": 3.4,
    "scene_count": 12.0
  },
  "months": [
    {
      "date": "2024-01",
      "scene_id": "S2B_...",
      "cloud_cover": 4.2,
      "metrics": { "ndvi_mean": 0.35, "area_hectares": 412.5 },
      "change_from_previous": null,
      "summary": "Optical scene covers 412.50 hectares.",
      "thumbnail_b64": "<base64 PNG>"
    }
  ],
  "trace": [
    {
      "tool_name": "acquisition.fetch",
      "duration_ms": 1842.3,
      "output_summary": "fetched 12 scene(s)",
      "status": "ok"
    }
  ],
  "answer": "The validated analysis covers 412.50 hectares...",
  "error": null
}
```

### v1 offline backend

#### `GET /health`
```json
{"status": "ok", "mode": "offline"}
curl http://localhost:8000/health
# {"status":"ok","mode":"v2-backend"}
```

#### `POST /query` (multipart form)
### React frontend

```bash
cd frontend
npm ci
npm run dev
```

Open `http://localhost:5173`. Draw a bounding box on the globe, pick a date range, type a question, and press **Analyze**.

```bash
# feature extraction
curl -X POST http://localhost:8000/query \
  -F 'query_text=Highlight water bodies' \
  -F 'image=@scene.png'

# change detection
curl -X POST http://localhost:8000/query \
  -F 'query_text=What changed between these dates?' \
  -F 'image_before=@before.png' \
  -F 'image_after=@after.png'
```

---

## Tests
# production checks
npm run typecheck
npm run build
```

### Streamlit client

```bash
source .venv/bin/activate
make frontend   # streamlit run frontend/streamlit_app.py
```

---

## API reference

### v2 backend

#### `GET /health`
```json
{"status": "ok", "mode": "v2-backend"}
```

#### `POST /analyze` and `POST /imagery/analyze`

Both routes accept the same JSON body and return the same response. `/imagery/analyze` is a compatibility alias for the React frontend.

**Request body:**
```json
{
  "bbox": [73.7, 18.4, 73.9, 18.6],
  "query": "What changed here over the last year?",
  "start_date": "2024-01",
  "end_date": "2024-12",
  "satellite": "auto"
}
```

`satellite` accepts `"auto"` (default), `"sentinel-2"`, or `"sentinel-1-rtc"`.
Dates accept `"YYYY-MM"` or `"YYYY-MM-DD"`.

**Response shape:**
```json
{
  "status": "ok",
  "query": "What changed here over the last year?",
  "bbox": [73.7, 18.4, 73.9, 18.6],
  "confidence": 0.87,
  "metrics": {
    "area_hectares": 412.5,
    "ndvi_mean": 0.38,
    "ndvi_vegetation_percentage": 54.2,
    "ndwi_water_percentage": 8.1,
    "changed_area_percentage": 3.4,
    "scene_count": 12.0
  },
  "months": [
    {
      "date": "2024-01",
      "scene_id": "S2B_...",
      "cloud_cover": 4.2,
      "metrics": { "ndvi_mean": 0.35, "area_hectares": 412.5 },
      "change_from_previous": null,
      "summary": "Optical scene covers 412.50 hectares.",
      "thumbnail_b64": "<base64 PNG>"
    }
  ],
  "trace": [
    {
      "tool_name": "acquisition.fetch",
      "duration_ms": 1842.3,
      "params": {"bbox": [73.7, 18.4, 73.9, 18.6]},
      "output": {"scene_count": 12, "scene_ids": ["S2B_..."]},
      "status": "ok"
    }
  ],
  "answer": "The validated analysis covers 412.50 hectares...",
  "error": null
}
```

## Tests

```bash
make test
# or
make test
# or
source .venv/bin/activate
python -m pytest -q
```

The suite covers:

- controller returns real metrics and a complete trace
- SAR assets are handled without array truthiness errors
- NDVI mean and SSIM change detection produce correct values
- API returns trace and metrics; validation rejects an invalid bbox

Tests use in-process NumPy arrays and a `FakeAcquisition` stub. No DNS, HTTP, or external service calls are made.

---
python -m pytest -q
```

The suite covers:

- controller returns real metrics and a complete trace
- SAR assets are handled without array truthiness errors
- NDVI mean and SSIM change detection produce correct values
- API returns trace and metrics; validation rejects an invalid bbox

Tests use in-process NumPy arrays and a `FakeAcquisition` stub. No DNS, HTTP, or external service calls are made.

---

## Docker

```bash
# build
# build
docker build -t satquery-agent:local .

# run tests (default entrypoint)

# run tests (default entrypoint)
docker run --rm satquery-agent:local

# run v2 backend
docker run --rm -p 8000:8000 satquery-agent:local \
  python -m uvicorn backend.api:app --host 0.0.0.0 --port 8000

# run v1 offline API
# run v2 backend
docker run --rm -p 8000:8000 satquery-agent:local \
  python -m uvicorn satquery.api:app --host 0.0.0.0 --port 8000
  python -m uvicorn backend.api:app --host 0.0.0.0 --port 8000

# run Streamlit demo
# run Streamlit client
docker run --rm -p 8501:8501 satquery-agent:local \
  python -m streamlit run frontend/streamlit_app.py \
  --server.address=0.0.0.0 --server.port=8501
```

---

## Agent War Room

The War Room modal (`AgentWarRoomModal.tsx`) visualises the live orchestration loop while an analysis runs:

- **Phase rail** — Pending → Planning → Reviewing → Executing → Complete
- **Agent cards** — Planner, Reviewer, and Executor fleet with retry badges
- **Reviewer feedback** — shows why a plan was rejected and sent back to the Planner
- **Terminal stream** — real `analysis_logs` from the backend trace, tagged `AGT / LOG / OUT / SYS`

The modal opens automatically when a prompt is submitted and closes when the report is ready.

---

## AnalysisReport

After synthesis the report panel shows:

- executive summary (plain text, inline bold supported)
- monthly thumbnail timeline — one row per scene with cloud, vegetation, and change bars
- land-cover breakdown (vegetation, water, built-up)
- key findings cards (area, NDVI, NDWI, change %)
- recommended next steps
- export buttons — PDF, GeoJSON, raw JSON, text snapshot
- **Highlight on map** toggle — flies to the bbox center and adds a visual marker

---

## Offline / online boundaries

| Component | Network required |
|---|---|
| v1 keyword router + OpenCV tools | No |
| Streamlit demo | No |
| v2 STAC acquisition (Planetary Computer) | Yes — for real imagery |
| v2 SAR fallback (Sentinel-1 RTC) | Yes — for real imagery |
| MapLibre basemap tiles | Yes — degrades gracefully |
| Nominatim location search | Yes — degrades gracefully |
| All analysis computation (NDVI, SSIM, area) | No — runs locally |
| LLM calls | None — no external model is used |

If Planetary Computer is unreachable the backend returns a structured `status: "error"` response. The War Room displays the failure instead of crashing the app.

---

## Planned improvements (Tier 2+)

- Copernicus Data Space integration for Sentinel-1 SLC and Sentinel-3 thermal
- NASA EarthData VIIRS night-time lights
- Landsat 8/9 thermal infrared (Band 10)
- Streaming SSE response so the War Room updates in real time during long fetches
- Persistent scene cache to avoid re-downloading the same monthly tiles
---

## Agent War Room

The War Room modal (`AgentWarRoomModal.tsx`) visualises the backend execution trace:

- **Phase rail** — backend request state and completion
- **Agent cards** — controller stages and executed tools
- **Terminal stream** — the exact `trace[]` returned by the API, including durations and outputs

The modal opens automatically when a prompt is submitted and remains available after completion so the returned trace can be inspected.

---

## AnalysisReport

After synthesis the report panel shows:

- executive summary (plain text, inline bold supported)
- monthly thumbnail timeline — one row per scene with cloud, vegetation, and change bars
- land-cover breakdown from returned vegetation, water, cloud, and change metrics
- key findings cards (area, NDVI, NDWI, change %)
- recommended next steps
- export buttons — PDF, GeoJSON, raw JSON, text snapshot
- **Highlight on map** toggle — flies to the bbox center and adds a visual marker

---

## Offline / online boundaries

| Component | Network required |
|---|---|
| Controller, validation, and mathematical tools | No — runs locally |
| Streamlit client | Yes — for real imagery |
| v2 STAC acquisition (Planetary Computer) | Yes — for real imagery |
| v2 SAR fallback (Sentinel-1 RTC) | Yes — for real imagery |
| MapLibre basemap tiles | Yes — degrades gracefully |
| Nominatim location search | Yes — degrades gracefully |
| All analysis computation (NDVI, SSIM, area) | No — runs locally |
| LLM calls | None — the composer uses only validated computed numbers |

If Planetary Computer is unreachable the backend returns a structured `status: "error"` response. The War Room displays the failure instead of crashing the app.

---

## Planned improvements (Tier 2+)

- Copernicus Data Space integration for Sentinel-1 SLC and Sentinel-3 thermal
- NASA EarthData VIIRS night-time lights
- Landsat 8/9 thermal infrared (Band 10)
- Streaming SSE response so the War Room updates in real time during long fetches
- Persistent scene cache to avoid re-downloading the same monthly tiles
