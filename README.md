# SatQuery-Agent

https://youtu.be/7omqHjBwN2M?feature=shared

Offline-first, agentic satellite vision-language query assistant for **SIH26167 / Frontier Buildathon**.

The project demonstrates a small local swarm of specialist agents/tools:

1. **Orchestrator Router Agent** — classifies natural-language intent without an external LLM and selects one specialist.
2. **Bi-Temporal Change Detection Tool** — compares two same-sized images with OpenCV matrix differencing and reports changed regions.
3. **Feature Extraction Tool** — segments water and vegetation with OpenCV HSV color thresholds and reports image coverage.

The same application service is used by FastAPI and Streamlit, so the demo remains usable with no network connection or cloud credentials.

## Architecture

```text
                       natural-language query
                                  |
                                  v
                    +---------------------------+
                    | Orchestrator Router Agent |
                    | deterministic intent      |
                    | classifier (offline)      |
                    +-------------+-------------+
                                  |
                    +-------------+-------------+
                    |                           |
                    v                           v
       +---------------------------+  +--------------------------+
       | Bi-Temporal Change Tool   |  | Feature Extraction Tool  |
       | cv2.absdiff + contours    |  | HSV masks + coverage     |
       +-------------+-------------+  +------------+-------------+
                     |                             |
                     +-------------+---------------+
                                   v
                         structured AgentResponse
                         (summary, metrics, boxes)
```

```text
                +----------------------+
                | Streamlit frontend   |
                +----------+-----------+
                           | shared service
                           v
                +----------------------+
                | FastAPI backend      |
                | GET /health          |
                | POST /query          |
                +----------+-----------+
                           |
                           v
                +----------------------+
                | local NumPy/OpenCV   |
                | no API or data fetch  |
                +----------------------+
```

## Repository layout

```text
.
├── satquery/
│   ├── api.py          # FastAPI app and multipart endpoint
│   ├── models.py       # Pydantic and domain response models
│   ├── router.py       # router agent and injectable classifier
│   ├── service.py      # uploaded-image decoding and application flow
│   └── tools.py        # OpenCV specialist tools
├── frontend/
│   ├── streamlit_app.py
│   └── src/              # React + MapLibre SatQuery AI interface
├── tests/
│   ├── test_api.py
│   ├── test_image_tools.py
│   └── test_router.py
├── Dockerfile
├── Makefile
├── requirements.txt
└── .python-version
```

## Requirements and offline behavior

- Python **3.11** is pinned in `.python-version`.
- Direct dependencies are version-pinned in `requirements.txt`.
- `langchain` is included as a pinned extension point, but the default router does not instantiate a hosted model or make an LLM call.
- Tests use only programmatic NumPy arrays and local encoded PNGs.
- No test performs DNS, HTTP, cloud SDK, or external LLM work.
- Uploaded images are decoded from bytes with OpenCV; no user-specific absolute paths are required.

## Local setup

From the repository root:

```bash
python3.11 -m venv .venv
.venv/bin/python -m pip install --upgrade pip
.venv/bin/python -m pip install --no-cache-dir -r requirements.txt
```

Copy `.env.example` to `.env` only if you want to customize the optional local settings. The default application needs no secret or API key.

If your Linux installation does not provide the `venv` module, install the distribution's Python 3.11 venv package before creating the environment. Do not install project dependencies globally.

## Test

The single project check is:

```bash
make test
```

`make test` runs `pytest -q` against the local suite. It is safe to run offline after dependencies have been installed. The suite covers:

- mock dependency-injected intent classification and routing;
- unknown and missing-image error paths;
- OpenCV change percentages and bounding boxes;
- water and vegetation coverage thresholds;
- FastAPI health and multipart query behavior.

## Run the backend

With the virtual environment active:

```bash
source .venv/bin/activate
make api
```

The API listens on `http://localhost:8000`. Visit `http://localhost:8000/docs` for the local OpenAPI UI or check health:

```bash
curl http://localhost:8000/health
```

Expected response:

```json
{"status":"ok","mode":"offline"}
```

Submit a feature extraction request with one local image:

```bash
curl -X POST http://localhost:8000/query \
  -F 'query_text=Highlight water bodies' \
  -F 'image=@relative/path/to/scene.png'
```

Submit a change detection request with two local images:

```bash
curl -X POST http://localhost:8000/query \
  -F 'query_text=What changed between these dates?' \
  -F 'image_before=@relative/path/to/before.png' \
  -F 'image_after=@relative/path/to/after.png'
```

## Run the Streamlit frontend

The frontend calls the same local application service directly, which keeps the demo functional even when the API is not separately started:

```bash
source .venv/bin/activate
make frontend
```

Open the printed local URL, enter one of the supported query styles, upload the corresponding image(s), and select **Run local analysis**. The UI shows the selected route, reason, summary, metrics, and bounding boxes.

Supported examples:

- `What changed between these dates?` → upload an earlier and later image.
- `Compare the two satellite images` → upload an earlier and later image.
- `Highlight water bodies` → upload one image.
- `How much vegetation is visible?` → upload one image.

### Included demo images

Ready-to-upload deterministic fixtures are in `demo/images/`:

- `change_before.png` and `change_after.png` for bi-temporal comparison;
- `feature_scene.png` for water and vegetation extraction.

See `demo/README.md` for expected queries and the regeneration command.

## Docker

The multi-stage Dockerfile installs the exact requirements into a builder virtual environment, copies that environment into a slim runtime image, and uses the offline test suite as its default entrypoint.

Build and run the default test container:

```bash
docker build -t satquery-agent:local .
docker run --rm satquery-agent:local
```

Run the API by overriding the default test entrypoint:

```bash
docker run --rm -p 8000:8000 satquery-agent:local \
  python -m uvicorn satquery.api:app --host 0.0.0.0 --port 8000
```

Run the Streamlit demo instead:

```bash
docker run --rm -p 8501:8501 satquery-agent:local \
  python -m streamlit run frontend/streamlit_app.py \
  --server.address=0.0.0.0 --server.port=8501
```

The Docker build needs access to the package index the first time it creates the image. Once the image is built, the application and its tests do not make external service calls.

## Response shape

Every routed request returns a structured response. A successful feature request has the following shape:

```json
{
  "status": "ok",
  "query": "Highlight water bodies",
  "intent": "feature_extraction",
  "route": "feature_extraction",
  "route_reason": "Feature or coverage language selected the extraction tool.",
  "result": {
    "tool": "feature_extraction",
    "summary": "Water bodies cover 12.50% and vegetation covers 41.25% of the image.",
    "metrics": {
      "water_coverage_percentage": 12.5,
      "vegetation_coverage_percentage": 41.25,
      "water_pixels": 1250,
      "vegetation_pixels": 4125
    },
    "bounding_boxes": [],
    "details": {"width": 100, "height": 100, "color_space": "HSV"}
  },
  "error": null
}
```

Validation failures are returned as a structured `status: "error"` agent response when the query is valid but an expected image is missing. Corrupt uploaded image bytes are rejected by the API with HTTP 422.

## Rebuild checklist

For a clean Linux rebuild:

1. Clone or copy this repository.
2. Confirm Python 3.11 and Docker are available.
3. Create a project-local `.venv` and install `requirements.txt`.
4. Run `make test`.
5. Run `make api` or `make frontend`, or build the Docker image.

No credentials, model downloads, satellite catalog, or external image service are required for the included Python demo and tests. The React map uses Nominatim and a public MapLibre demo style when those browser network features are available, and shows a recoverable offline state when they are not.

## React SatQuery AI frontend

The interactive MapLibre interface lives in `frontend/` alongside the existing Streamlit demo. It includes the globe-to-Mercator transition, Nominatim location search, analysis prompt context, land-cover metrics, and the Agent War Room modal.

```bash
cd frontend
npm ci
npm run dev
```

Open `http://localhost:5173`. Run the production checks with:

```bash
npm run typecheck
npm run build
```
