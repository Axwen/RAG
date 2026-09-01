#!/usr/bin/env bash
# PROBE-005 Stage B (Chat) runner — OpenAI **Responses API** (/v1/responses).
#
# Supplier-neutral: switch providers with CHAT_BASE / CHAT_MODEL / CHAT_API_KEY
# only, no code change. Current default target: https://fluxionai.space/v1
# (user-designated 2026-08-26); the earlier agentrouter.org run is kept as its
# own report, see docs/engineering/probe-results/.
#
# NOTE on User-Agent: default is EMPTY, i.e. the plain urllib UA — that is what a
# NestJS/worker backend can actually send. agentrouter.org gated admission on
# `User-Agent: claude-cli/*`; that gate was recorded as a finding, never adopted
# as architecture. Set CHAT_USER_AGENT only to reproduce such a gated endpoint.
#
# CHAT_MODEL is REQUIRED: a model id from one provider is meaningless at another
# base, and guessing burns a billed run.
#
# The key is NEVER passed on the command line. Provide it by exporting
# CHAT_API_KEY, or by putting CHAT_API_KEY=... into an untracked env file and
# pointing PROBE_CHAT_ENV_FILE at it (default: repository-local ignored
# `.env.probe005-chat`).
#
# REAL COST: makes live billed calls (synthetic short customer-service text only).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT_DIR="${OUT_DIR:-$REPO_ROOT/docs/engineering/probe-results}"
ENV_FILE="${PROBE_CHAT_ENV_FILE:-$REPO_ROOT/.env.probe005-chat}"

if [[ -z "${CHAT_API_KEY:-}" && -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck source=/dev/null  # 运行期 .env，路径不定
  . "$ENV_FILE"
  set +a
fi
if [[ -z "${CHAT_API_KEY:-}" ]]; then
  echo "ERROR: CHAT_API_KEY not set and no key in '$ENV_FILE'." >&2
  echo "  export CHAT_API_KEY=...   # or write it into that untracked file" >&2
  exit 3
fi
if [[ -z "${CHAT_MODEL:-}" ]]; then
  echo "ERROR: CHAT_MODEL not set (base=${CHAT_BASE:-https://fluxionai.space/v1})." >&2
  echo "  export CHAT_MODEL=<provider model id>   # confirm it with the provider first" >&2
  exit 3
fi

exec python3 "$REPO_ROOT/scripts/probes/probe_005_responses.py" \
  --base "${CHAT_BASE:-https://fluxionai.space/v1}" \
  --model "$CHAT_MODEL" \
  --provider "${CHAT_PROVIDER:-fluxionai}" \
  --user-agent "${CHAT_USER_AGENT:-}" \
  --out "$OUT_DIR" \
  "$@"
