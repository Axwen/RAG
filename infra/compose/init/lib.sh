#!/usr/bin/env bash
# 初始化脚本共享工具。所有初始化步骤都必须幂等：重复执行不产生重复副作用。
set -Eeuo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
COMPOSE_DIR="${REPO_ROOT}/infra/compose"

log()  { printf '[init] %s\n' "$*" >&2; }
warn() { printf '[init][warn] %s\n' "$*" >&2; }
die()  { printf '[init][error] %s\n' "$*" >&2; exit 1; }

# 从仓库根 .env 载入本地默认值；已经由外围环境提供的变量优先保留。
load_env() {
  local env_file="${REPO_ROOT}/.env"
  [[ -f "${env_file}" ]] || return 0

  local key line
  local -A externally_set=()
  while IFS= read -r line; do
    [[ "${line}" =~ ^[[:space:]]*(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)= ]] || continue
    key="${BASH_REMATCH[2]}"
    if [[ ${!key+x} ]]; then
      externally_set["${key}"]="${!key}"
    fi
  done < "${env_file}"

  set -a
  # shellcheck disable=SC1090
  source "${env_file}"
  set +a

  for key in "${!externally_set[@]}"; do
    export "${key}=${externally_set[${key}]}"
  done
}

require_env() {
  local name
  for name in "$@"; do
    [[ -n "${!name:-}" ]] || die "缺少环境变量 ${name}（应在未跟踪的 .env 或运行环境中提供）"
  done
}

compose() {
  docker compose --project-directory "${REPO_ROOT}" -f "${COMPOSE_DIR}/compose.yml" "$@"
}

# Compose 默认网络名，供一次性容器（mc）接入
compose_network() {
  printf '%s_default' "${COMPOSE_PROJECT_NAME:-rag-local}"
}

# 轮询等待，避免依赖宿主是否安装了特定客户端
wait_for() {
  local label="$1" attempts="$2"; shift 2
  local i
  for ((i = 1; i <= attempts; i++)); do
    if "$@" >/dev/null 2>&1; then
      log "${label} 就绪"
      return 0
    fi
    sleep 2
  done
  die "${label} 在 $((attempts * 2)) 秒内未就绪"
}
