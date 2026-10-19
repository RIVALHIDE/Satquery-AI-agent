"""Streamlit demo for the local SatQuery-Agent service."""

from __future__ import annotations

import streamlit as st

from satquery.service import analyze_query


st.set_page_config(page_title="SatQuery-Agent", page_icon="🛰️", layout="wide")
st.title("🛰️ SatQuery-Agent")
st.caption("Offline-first, agentic satellite vision-language query assistant")

st.info(
    "The router and OpenCV specialists run in this process. No LLM API, cloud "
    "credential, or network connection is needed."
)

query = st.text_area(
    "Ask a satellite-image question",
    placeholder="What changed between these dates? or Highlight water bodies",
)

left, right = st.columns(2)
with left:
    before = st.file_uploader(
        "Earlier image (change detection)", type=["png", "jpg", "jpeg"], key="before"
    )
    image = st.file_uploader(
        "Single image (water / vegetation extraction)",
        type=["png", "jpg", "jpeg"],
        key="single",
    )
with right:
    after = st.file_uploader(
        "Later image (change detection)", type=["png", "jpg", "jpeg"], key="after"
    )

if st.button("Run local analysis", type="primary"):
    if not query.strip():
        st.warning("Enter a question before running the agent.")
    else:
        try:
            response = analyze_query(
                query,
                before_bytes=before.getvalue() if before else None,
                after_bytes=after.getvalue() if after else None,
                image_bytes=image.getvalue() if image else None,
            )
        except ValueError as exc:
            st.error(str(exc))
        else:
            st.subheader("Orchestrator response")
            st.write(f"**Route:** `{response.route}`")
            st.write(f"**Reason:** {response.route_reason}")
            if response.status == "ok" and response.result:
                st.success(response.result.summary)
                st.json(response.result.model_dump())
            else:
                st.error(response.error or "The agent could not complete the request.")
