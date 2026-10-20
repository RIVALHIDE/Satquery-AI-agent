.PHONY: test api frontend

PYTHONPATH := $(CURDIR)/.deps:$(CURDIR)
PYTHON ?= $(if $(wildcard $(CURDIR)/.venv/bin/python),$(CURDIR)/.venv/bin/python,python3.11)

test:
	PYTHONPATH="$(PYTHONPATH)" $(PYTHON) -m pytest -q

api:
	PYTHONPATH="$(PYTHONPATH)" $(PYTHON) -m uvicorn backend.api:app --host 0.0.0.0 --port 8000

frontend:
	PYTHONPATH="$(PYTHONPATH)" $(PYTHON) -m streamlit run frontend/streamlit_app.py
