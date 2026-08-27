#!/usr/bin/env bash
# PROBE-002 runner: build the DeepDOC parser probe image, generate synthetic
# fixtures in-container, run the host driver, save results, tear down.
#
# THROWAWAY probe harness. Vendors RAGFlow DeepDOC source from references/ into
# the build context (references/ stays read-only). No secrets read or emitted.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${HERE}/../.." && pwd)"          # /home/h/work/rag
CTX="${HERE}/compose/deepdoc"
RAGFLOW="${REPO_ROOT}/references/ragflow"
IMAGE="probe002-deepdoc:local"
NAME="probe002-deepdoc"
PORT="${PORT:-9390}"
OUT_DIR="${REPO_ROOT}/docs/engineering/probe-results"
FIX_HOST="${CTX}/generated-fixtures"

log() { printf '\n=== %s ===\n' "$*"; }

# --- 1. Vendor DeepDOC source (fixed snapshot copy) ------------------------
log "Vendoring DeepDOC source from references/ragflow"
rm -rf "${CTX}/vendored"
mkdir -p "${CTX}/vendored/deepdoc/parser"
cp -r "${RAGFLOW}/deepdoc/vision" "${CTX}/vendored/deepdoc/vision"
cp "${RAGFLOW}/deepdoc/parser/pdf_parser.py" "${CTX}/vendored/deepdoc/parser/pdf_parser.py"
cp "${RAGFLOW}/deepdoc/parser/utils.py" "${CTX}/vendored/deepdoc/parser/utils.py"
# Drop test scaffolding that pulls unittest/argparse mains we don't need.
find "${CTX}/vendored" -name "t_*.py" -delete 2>/dev/null || true

# --- 2. Build image --------------------------------------------------------
log "Building ${IMAGE}"
docker build -t "${IMAGE}" "${CTX}"

# --- 3. Run container ------------------------------------------------------
log "Starting container ${NAME}"
docker rm -f "${NAME}" >/dev/null 2>&1 || true
mkdir -p "${FIX_HOST}"
docker run -d --name "${NAME}" --memory=12g \
    -p "${PORT}:9390" \
    -v "${FIX_HOST}:/fixtures" \
    "${IMAGE}" >/dev/null

# --- 4. Wait for health ----------------------------------------------------
log "Waiting for /health"
for i in $(seq 1 30); do
    if curl -fsS "http://localhost:${PORT}/health" >/dev/null 2>&1; then
        echo "healthy after ${i}s"
        break
    fi
    if [ "$i" -eq 30 ]; then
        echo "ERROR: service did not become healthy" >&2
        docker logs "${NAME}" >&2 || true
        docker rm -f "${NAME}" >/dev/null 2>&1 || true
        exit 1
    fi
    sleep 1
done

# --- 5. Generate synthetic fixtures in-container ---------------------------
log "Generating synthetic PDF fixtures"
docker exec "${NAME}" python /app/app/make_fixtures.py

# --- 6. Run host driver ----------------------------------------------------
log "Running host driver"
mkdir -p "${OUT_DIR}"
python3 "${HERE}/probe_002_deepdoc.py" \
    --base "http://localhost:${PORT}" \
    --fixtures "${FIX_HOST}" \
    --sample "${HERE}/fixtures/deepdoc/sample.md" \
    --out "${OUT_DIR}" || DRIVER_RC=$? && DRIVER_RC=${DRIVER_RC:-0}

# --- 7. Save container logs + teardown -------------------------------------
log "Saving container logs"
docker logs "${NAME}" > "${OUT_DIR}/probe-002-container.log" 2>&1 || true

if [ "${KEEP_CONTAINER:-0}" != "1" ]; then
    log "Tearing down container"
    docker rm -f "${NAME}" >/dev/null 2>&1 || true
fi

echo
echo "PROBE-002 driver exit code: ${DRIVER_RC}"
exit "${DRIVER_RC}"
