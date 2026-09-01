#!/usr/bin/env bash
# PROBE-005 Stage A (Embedding) runner — OpenRouter, OpenAI-compatible /v1/embeddings.
#
# The key is NEVER passed on the command line (it would land in ps/history) and
# never written into the repo. Provide it one of two ways:
#   1) export OPENROUTER_API_KEY=... in the calling shell, or
#   2) put OPENROUTER_API_KEY=... in an untracked env file and point
#      PROBE_ENV_FILE at it (default: repository-local ignored `.env.probe005`).
#
# REAL COST: this makes live billed embedding calls (synthetic short text only,
# well under 0.1 CNY for a full run).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT_DIR="${OUT_DIR:-$REPO_ROOT/docs/engineering/probe-results}"
ENV_FILE="${PROBE_ENV_FILE:-$REPO_ROOT/.env.probe005}"

if [[ -z "${OPENROUTER_API_KEY:-}" && -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck source=/dev/null  # 运行期 .env，路径不定
  . "$ENV_FILE"
  set +a
fi
if [[ -z "${OPENROUTER_API_KEY:-}" ]]; then
  echo "ERROR: OPENROUTER_API_KEY not set and no key in '$ENV_FILE'." >&2
  echo "  export OPENROUTER_API_KEY=...   # or write it into that untracked file" >&2
  exit 3
fi

exec python3 "$REPO_ROOT/scripts/probes/probe_005_embedding.py" \
  --base "${OPENROUTER_BASE:-https://openrouter.ai/api/v1}" \
  --model "${EMBED_MODEL:-qwen/qwen3-embedding-8b}" \
  --provider openrouter \
  --out "$OUT_DIR" \
  "$@"
