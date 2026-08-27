# PROBE-002 DeepDOC parser probe image (THROWAWAY probe harness).
#
# Option X: vendor RAGFlow's real DeepDOC assembly layer (deepdoc/vision +
# deepdoc/parser/pdf_parser.py) and isolate it behind minimal config/glue stubs
# (the jest.mock pattern RAGFlow itself ships in server/docker_stubs.py), then
# call RAGFlowPdfParser().parse_into_bboxes() in-process. No LitServe model
# server, no RAGFlow storage/DB layer.
#
# Build context = scripts/probes/compose/deepdoc/. The run script populates
# ./vendored/ from references/ragflow BEFORE build (references/ stays read-only).
FROM ubuntu:24.04

ARG HF_ENDPOINT=https://hf-mirror.com
ARG PIP_INDEX_URL=https://mirrors.aliyun.com/pypi/simple/

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONPATH=/app \
    PYTHONUNBUFFERED=1 \
    DEVICE=cpu \
    LAYOUT_RECOGNIZER_TYPE=onnx \
    PARALLEL_DEVICES=0 \
    PORT=9390 \
    RAGFLOW_PROJECT_BASE=/app

RUN apt-get update && apt-get install -y --no-install-recommends \
        python3.12 python3.12-venv python3-pip \
        libglib2.0-0 libgl1 libgomp1 libgdiplus \
        fonts-wqy-zenhei curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN python3.12 -m venv /app/.venv
ENV PATH=/app/.venv/bin:$PATH

RUN pip install --no-cache-dir -i ${PIP_INDEX_URL} \
        numpy "onnxruntime>=1.20.0" opencv-python-headless pillow \
        "pyclipper>=1.4.0" shapely six \
        pdfplumber pypdf "xgboost-cpu==2.1.4" scikit-learn chardet \
        huggingface_hub reportlab

WORKDIR /app

# Pre-place models FIRST, keyed only on download_models.py, so later edits to
# app/ or stubs/ don't invalidate the (slow) model-download layer. Runtime is
# fully offline (HF_HUB_OFFLINE=1 at run).
COPY app/download_models.py /app/app/download_models.py
RUN HF_ENDPOINT=${HF_ENDPOINT} python /app/app/download_models.py /app/rag/res/deepdoc

# 1) Config/glue stubs (create deepdoc/__init__, deepdoc/parser/__init__,
#    common/*, rag/*). 2) Real vendored vision + PDF parser layered on top.
COPY stubs/ /app/
COPY vendored/deepdoc/vision/ /app/deepdoc/vision/
COPY vendored/deepdoc/parser/pdf_parser.py /app/deepdoc/parser/pdf_parser.py
COPY vendored/deepdoc/parser/utils.py /app/deepdoc/parser/utils.py
COPY app/ /app/app/

EXPOSE 9390
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=5 \
    CMD curl -fsS http://localhost:9390/health || exit 1

ENV HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1
CMD ["python", "/app/app/parse_service.py"]
