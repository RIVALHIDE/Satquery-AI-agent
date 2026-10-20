# Build dependencies in an isolated stage, then copy only the runtime venv.
FROM python:3.11-slim AS builder

ENV VIRTUAL_ENV=/opt/venv
RUN python -m venv "$VIRTUAL_ENV"
ENV PATH="$VIRTUAL_ENV/bin:$PATH"

WORKDIR /build
COPY requirements.txt ./requirements.txt
RUN pip install --no-cache-dir --upgrade pip \
    && pip install --no-cache-dir -r requirements.txt

FROM python:3.11-slim AS runtime

ENV VIRTUAL_ENV=/opt/venv
ENV PATH="$VIRTUAL_ENV/bin:$PATH"
ENV PYTHONUNBUFFERED=1
WORKDIR /app

COPY --from=builder /opt/venv /opt/venv
COPY backend ./backend
COPY frontend ./frontend
COPY tests ./tests
COPY pyproject.toml Makefile .python-version ./

# The default container behavior is the offline test suite. A CMD keeps it
# easy to override with uvicorn or streamlit when running an application.
CMD ["python", "-m", "pytest", "-q"]
