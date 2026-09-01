#!/usr/bin/env bash
# PROBE-005 Stage B addendum runner — `reasoning_effort` A/B (low vs high).
#
# Answers a DISTRIBUTION question that the contract probe cannot: is
# `step-3.5-flash-2603` + reasoning_effort=low actually within ADR-0027's
# high-risk P95 <= 3.5 s budget, and does turning reasoning down cost answer or
# citation quality? Arms are interleaved inside the script so provider-load drift
# hits both equally.
#
# Supplier/model-neutral: CHAT_BASE / CHAT_MODEL / CHAT_PROVIDER only.
# CHAT_MODEL is REQUIRED (guessing a model id burns billed calls).
#
# The key is NEVER passed on the command line: export CHAT_API_KEY (or
# STEPFUN_API_KEY), or put it in an untracked env file pointed at by
# PROBE_CHAT_ENV_FILE (default: repository-local ignored `.env.probe005-chat`).
#
# REAL COST: 2 * RUNS billed streaming calls (~¥0.03 at RUNS=20 on step-3.5-flash).
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
  exit 3
fi
if [[ -z "${CHAT_MODEL:-}" ]]; then
  echo "ERROR: CHAT_MODEL not set (base=${CHAT_BASE:-https://api.stepfun.com/v1})." >&2
  echo "  export CHAT_MODEL=step-3.5-flash-2603   # confirm via {base}/models" >&2
  exit 3
fi

exec python3 "$REPO_ROOT/scripts/probes/probe_005_chat_effort_ab.py" \
  --base "${CHAT_BASE:-https://api.stepfun.com/v1}" \
  --model "$CHAT_MODEL" \
  --provider "${CHAT_PROVIDER:-stepfun}" \
  --arms "${CHAT_AB_ARMS:-low,high}" \
  --baseline-arm "${CHAT_AB_BASELINE:-low}" \
  --runs "${CHAT_AB_RUNS:-20}" \
  --rpm "${CHAT_RPM:-8}" \
  --max-tokens "${CHAT_MAX_TOKENS:-1200}" \
  --out "$OUT_DIR" \
  "$@"
