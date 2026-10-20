"""Small Streamlit client for the trace-backed SatQuery AI v2 controller."""

from __future__ import annotations

import streamlit as st

from backend.agent.controller import AnalysisController
from backend.models.contracts import InputConfig


st.set_page_config(page_title="SatQuery AI", page_icon="🛰️", layout="wide")
st.title("🛰️ SatQuery AI")
st.caption("Trace-backed satellite analysis with real STAC acquisition and local tools")
st.info(
    "The v2 controller fetches Planetary Computer scenes, validates raster evidence, "
    "runs deterministic tools, and returns the exact execution trace."
)

with st.form("analysis"):
    query = st.text_input("Question", value="What changed between these dates?")
    bbox_text = st.text_input("BBox [west, south, east, north]", value="73.84, 18.50, 73.88, 18.54")
    start_date = st.text_input("Start date", value="2024-01")
    end_date = st.text_input("End date", value="2024-03")
    satellite = st.selectbox("Satellite", ["auto", "sentinel-2", "sentinel-1-rtc"])
    submitted = st.form_submit_button("Run backend analysis", type="primary")

if submitted:
    try:
        bbox = [float(value.strip()) for value in bbox_text.split(",")]
        request = InputConfig(
            bbox=bbox,
            query=query,
            start_date=start_date,
            end_date=end_date,
            satellite=satellite,
        )
        response = AnalysisController().analyze(request)
    except (ValueError, TypeError) as exc:
        st.error(str(exc))
    else:
        if response.status == "ok":
            st.success(response.answer)
        else:
            st.error(response.error or "The backend could not complete the request.")
        st.subheader("Exact metrics")
        st.json(response.metrics)
        st.subheader("Execution trace")
        st.json([step.model_dump() for step in response.trace])
