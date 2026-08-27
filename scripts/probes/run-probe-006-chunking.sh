#!/usr/bin/env bash
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${HERE}/../.." && pwd)"
OUT_DIR="${OUT_DIR:-${REPO_ROOT}/docs/engineering/probe-results}"
ARTIFACT_DIR="${PROBE006_ARTIFACTS:-${OUT_DIR}/probe-002-artifacts}"
GOLDEN="${PROBE006_GOLDEN:-${HERE}/fixtures/chunking/probe-006-golden-subset.json}"
ENV_FILE="${PROBE_ENV_FILE:-${REPO_ROOT}/.env.probe005}"

if [[ -z "${OPENROUTER_API_KEY:-}" && -f "${ENV_FILE}" ]]; then
  set -a
  . "${ENV_FILE}"
  set +a
fi

mkdir -p "${OUT_DIR}"
exec python3 "${HERE}/probe_006_chunking.py" \
  --artifacts "${ARTIFACT_DIR}" \
  --golden "${GOLDEN}" \
  --out "${OUT_DIR}/probe-006-chunking-citation-locating" \
  --embed-base "${OPENROUTER_BASE:-https://openrouter.ai/api/v1}" \
  --embed-model "${EMBED_MODEL:-qwen/qwen3-embedding-8b}" \
  --opensearch "${OPENSEARCH_PROBE_URL:-}" \
  "$@"
