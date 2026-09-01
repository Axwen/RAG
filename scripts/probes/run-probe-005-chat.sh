#!/usr/bin/env bash
# PROBE-005 Stage B (Chat) runner — OpenAI **Chat Completions** (/v1/chat/completions).
#
# Chat provider = StepFun (阶跃星辰), user-designated 2026-08-26. StepFun exposes
# OpenAI-compatible Chat Completions and Anthropic-compatible Messages but NO
# Responses API, so the Chat leg runs on /chat/completions (probe_005_chat.py).
# Unlike the earlier relays (agentrouter/fluxionai on the /responses leg), StepFun
# is a first-party model provider serving its own Step family.
#
# Supplier-neutral: switch providers with CHAT_BASE / CHAT_MODEL / CHAT_API_KEY /
# CHAT_PROVIDER only, no code change. Reports are written per-provider
# (probe-005-model-adapter-chat-<provider>.{md,json}) so a new provider never
# overwrites a previous provider's fact record (the -agentrouter run is kept).
#
# CHAT_MODEL is REQUIRED: a model id from one provider is meaningless at another
# base, and guessing burns a billed run. Confirm it against {base}/models first.
#
# The key is NEVER passed on the command line. Provide it by exporting
# CHAT_API_KEY (or STEPFUN_API_KEY), or by putting CHAT_API_KEY=... into an
# untracked env file and pointing PROBE_CHAT_ENV_FILE at it
# (default: repository-local ignored `.env.probe005-chat`).
#
# REAL COST: makes live billed calls (synthetic short customer-service text only).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT_DIR="${OUT_DIR:-$REPO_ROOT/docs/engineering/probe-results}"
ENV_FILE="${PROBE_CHAT_ENV_FILE:-$REPO_ROOT/.env.probe005-chat}"

if [[ -z "${CHAT_API_KEY:-}" && -z "${STEPFUN_API_KEY:-}" && -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck source=/dev/null  # 运行期 .env，路径不定
  . "$ENV_FILE"
  set +a
fi
if [[ -z "${CHAT_API_KEY:-}" && -z "${STEPFUN_API_KEY:-}" ]]; then
  echo "ERROR: CHAT_API_KEY not set and no key in '$ENV_FILE'." >&2
  echo "  export CHAT_API_KEY=...   # or write it into that untracked file" >&2
  exit 3
fi
if [[ -z "${CHAT_MODEL:-}" ]]; then
  echo "ERROR: CHAT_MODEL not set (base=${CHAT_BASE:-https://api.stepfun.com/v1})." >&2
  echo "  export CHAT_MODEL=<provider model id>   # e.g. step-3.5-flash; confirm via {base}/models" >&2
  exit 3
fi

exec python3 "$REPO_ROOT/scripts/probes/probe_005_chat.py" \
  --base "${CHAT_BASE:-https://api.stepfun.com/v1}" \
  --model "$CHAT_MODEL" \
  --provider "${CHAT_PROVIDER:-stepfun}" \
  --user-agent "${CHAT_USER_AGENT:-}" \
  --reasoning-effort "${CHAT_REASONING_EFFORT:-}" \
  --rpm "${CHAT_RPM:-10}" \
  --out "$OUT_DIR" \
  "$@"
