.PHONY: test api frontend

PYTHONPATH := $(CURDIR)/.deps:$(CURDIR)
PYTHON ?= python3.11

test:
	PYTHONPATH="$(PYTHONPATH)" $(PYTHON) -m pytest -q

api:
	$(PYTHON) -m uvicorn satquery.api:app --host 0.0.0.0 --port 8000

frontend:
	$(PYTHON) -m streamlit run frontend/streamlit_app.py
