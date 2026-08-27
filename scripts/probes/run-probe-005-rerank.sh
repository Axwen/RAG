#!/usr/bin/env bash
# PROBE-005 Stage C (Reranker) runner — OpenRouter POST {base}/rerank.
#
# Why this stage exists: ADR-0017 recorded "OpenRouter 无 rerank 端点" and left
# the Reranker undecided. Route existence was re-tested by 401-vs-404
# discrimination (a bogus path returns 404, /rerank returns 401) BEFORE any
# billed call, and the route is real. This stage measures whether the endpoint
# and model are actually usable as the MVP Reranker.
#
# The key is NEVER passed on the command line (it would land in ps/history) and
# never written into the repo. Provide it one of two ways:
#   1) export OPENROUTER_API_KEY=... in the calling shell, or
#   2) put OPENROUTER_API_KEY=... in an untracked env file and point
#      PROBE_ENV_FILE at it (default: repository-local ignored `.env.probe005`).
#
# REAL COST: live billed rerank calls on synthetic short text. The default
# candidate curve (8/64/256/1024 plus a 2048 oversize probe) measured well
# under 1 CNY for a full run; usage.cost is reported per call in the report.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT_DIR="${OUT_DIR:-$REPO_ROOT/docs/engineering/probe-results}"
ENV_FILE="${PROBE_ENV_FILE:-$REPO_ROOT/.env.probe005}"

if [[ -z "${OPENROUTER_API_KEY:-}" && -f "$ENV_FILE" ]]; then
  set -a; . "$ENV_FILE"; set +a
fi
if [[ -z "${OPENROUTER_API_KEY:-}" && -z "${RERANK_API_KEY:-}" ]]; then
  echo "ERROR: no OPENROUTER_API_KEY / RERANK_API_KEY (and none in '$ENV_FILE')." >&2
  echo "  export OPENROUTER_API_KEY=...   # or write it into that untracked file" >&2
  exit 3
fi

exec python3 "$REPO_ROOT/scripts/probes/probe_005_rerank.py" \
  --base "${RERANK_BASE:-https://openrouter.ai/api/v1}" \
  --model "${RERANK_MODEL:-qwen/qwen3-reranker-8b}" \
  --provider "${RERANK_PROVIDER:-openrouter}" \
  --sizes "${RERANK_SIZES:-8,64,256,1024}" \
  --out "$OUT_DIR" \
  "$@"
