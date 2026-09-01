#!/usr/bin/env bash
# DX 基线测量（devex 评审 T6：DX 度量 4/10 的退场条件）。
#
# 把 T0 那次一次性手工实测变成可复跑的脚本：同一口径量黄金路径与反馈回路耗时，
# 输出人读表格 + 机读 JSON，供 /plan-devex-review 的 boomerang 前后对比。
#
# 测量阶段（默认热态、非破坏）：
#   install    pnpm install --frozen-lockfile（幂等）
#   verify     pnpm run verify 全链（反馈回路，目标 ≤20s）
#   infra_up   pnpm run infra:up（含 preflight；容器已在跑则接近空转）
#   bootstrap  pnpm run bootstrap（Keycloak realm / MinIO bucket / migrate / seed，幂等）
#   api_ready  起 API dev 进程直到 /health/ready 返回 200（六依赖全 up），随后关掉
# TTHW = infra_up + bootstrap + api_ready（D4 定义的魔法时刻），目标 <120s。
#
# 判据（与 check-env.sh 同一约定）：阶段命令失败或就绪超时才是 ❌（退出 1）；
# 只是没达成目标耗时算 ⚠️，退出 0——性能目标受机器状态影响，不该拦住本地运行。
# 需要把目标当门禁时加 --strict。
#
# 破坏性开关：--cold 会 docker compose down -v（删中间件数据卷，含本地开发库）
# 并 rm -rf node_modules，因此必须同时显式给 --yes-destroy-data。默认永不破坏。
set -Eeuo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${HERE}/.." && pwd)"
cd "${REPO_ROOT}"

TARGET_VERIFY_MS=20000
TARGET_TTHW_MS=120000

MODE=hot
CONFIRM_DESTROY=0
RUN_VERIFY=1
STRICT=0
READY_TIMEOUT=180
OUT_FILE=""

usage() {
  cat <<'USAGE'
用法：bash scripts/dx-baseline.sh [选项]

  --cold                冷启动测量：先删数据卷与 node_modules（需配 --yes-destroy-data）
  --yes-destroy-data    确认 --cold 的破坏性操作
  --skip-verify         跳过 verify 全链，只量黄金路径
  --strict              目标耗时未达成时退出 1（默认只警告）
  --timeout <秒>        等 /health/ready 的上限，默认 180
  --out <文件>          JSON 结果写到指定路径（默认 .dx-baseline/latest.json）
  -h, --help            显示本帮助
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --cold) MODE=cold ;;
    --yes-destroy-data) CONFIRM_DESTROY=1 ;;
    --skip-verify) RUN_VERIFY=0 ;;
    --strict) STRICT=1 ;;
    --timeout)
      READY_TIMEOUT="${2:?--timeout 需要秒数}"
      shift
      ;;
    --out)
      OUT_FILE="${2:?--out 需要文件路径}"
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "未知选项：$1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

if [[ "${MODE}" == cold && "${CONFIRM_DESTROY}" -ne 1 ]]; then
  cat >&2 <<'REFUSE'
--cold 会执行 docker compose down -v 并 rm -rf node_modules：
中间件数据卷（含本地开发数据库里的所有数据）与已安装依赖都会被删除，且不可恢复。
确认要这么做时重跑：bash scripts/dx-baseline.sh --cold --yes-destroy-data
REFUSE
  exit 2
fi

RUN_DIR="${REPO_ROOT}/.dx-baseline"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
LOG_DIR="${RUN_DIR}/logs-${STAMP}"
mkdir -p "${LOG_DIR}"
[[ -n "${OUT_FILE}" ]] || OUT_FILE="${RUN_DIR}/latest.json"

declare -A STAGE_MS=()
declare -A STAGE_RC=()
STAGE_ORDER=()
fail=0
warn_count=0

# EPOCHREALTIME 在小数点为逗号的 locale 下也要能用。
now_ms() {
  local raw="${EPOCHREALTIME/,/.}"
  awk -v t="${raw}" 'BEGIN { printf "%d", t * 1000 }'
}

fmt_ms() { awk -v ms="$1" 'BEGIN { printf "%.1fs", ms / 1000 }'; }

item() { printf '  %s %s\n' "$1" "$2"; }

record() {
  local name="$1" ms="$2" rc="$3"
  STAGE_ORDER+=("${name}")
  STAGE_MS["${name}"]="${ms}"
  STAGE_RC["${name}"]="${rc}"
}

# 跑一个阶段并计时。命令输出进日志，失败时回显尾部——表格要保持可读，
# 但失败必须能当场诊断，不能只留一个退出码。
run_stage() {
  local name="$1" label="$2"
  shift 2
  local log="${LOG_DIR}/${name}.log"
  local start end rc=0
  printf '▶ %-10s %s\n' "${name}" "${label}"
  start="$(now_ms)"
  if ! "$@" >"${log}" 2>&1; then
    rc=$?
  fi
  end="$(now_ms)"
  record "${name}" "$((end - start))" "${rc}"
  if [[ "${rc}" -ne 0 ]]; then
    fail=1
    item "❌" "${name} 失败（退出码 ${rc}），日志尾部："
    tail -n 15 "${log}" | sed 's/^/      /'
  else
    item "✅" "$(fmt_ms "${STAGE_MS[${name}]}")"
  fi
}

api_port() {
  if [[ -n "${API_PORT:-}" ]]; then
    printf '%s' "${API_PORT}"
    return
  fi
  local from_env=""
  if [[ -f "${REPO_ROOT}/.env" ]]; then
    from_env="$(sed -n 's/^[[:space:]]*API_PORT=\([0-9]\{1,\}\).*/\1/p' "${REPO_ROOT}/.env" | tail -n 1)"
  fi
  printf '%s' "${from_env:-3001}"
}

PORT="$(api_port)"
READY_URL="http://127.0.0.1:${PORT}/health/ready"
READY_DEPS=0
API_PGID=""

cleanup() {
  if [[ -n "${API_PGID}" ]]; then
    kill -TERM "-${API_PGID}" 2>/dev/null || true
    API_PGID=""
  fi
}
trap cleanup EXIT INT TERM

# 起 API dev 直到 /health/ready 200。用 setsid 单独成组，便于连 nodemon 的子进程一起收掉。
stage_api_ready() {
  local log="${LOG_DIR}/api_ready.log"
  printf '▶ %-10s %s\n' "api_ready" "起 API dev 等 ${READY_URL} 返回 200"

  if curl -fsS -m 2 "http://127.0.0.1:${PORT}/health/live" >/dev/null 2>&1; then
    record "api_ready" 0 1
    fail=1
    item "❌" "端口 ${PORT} 上已有服务在跑，TTHW 会量不准：先停掉它，或换 API_PORT 重跑"
    return
  fi

  # 测量有效性：外壳里已有依赖变量时，就绪并不能证明 .env 自动预载（DX-T1）还成立。
  if [[ -n "${DATABASE_URL:-}" ]]; then
    item "⚠️" "当前 shell 已导出 DATABASE_URL：本次不构成「无需手工 source .env」的证据"
  fi

  local start end rc=1 deadline body=""
  start="$(now_ms)"
  setsid pnpm --filter @rag/api dev >"${log}" 2>&1 </dev/null &
  local pid=$!
  API_PGID="${pid}"
  deadline=$(($(now_ms) + READY_TIMEOUT * 1000))
  while :; do
    if body="$(curl -fsS -m 5 "${READY_URL}" 2>/dev/null)"; then
      rc=0
      break
    fi
    if ! kill -0 "${pid}" 2>/dev/null; then
      rc=2
      break
    fi
    if [[ "$(now_ms)" -ge "${deadline}" ]]; then
      rc=3
      break
    fi
    sleep 0.2
  done
  end="$(now_ms)"
  record "api_ready" "$((end - start))" "${rc}"

  if [[ "${rc}" -eq 0 ]]; then
    READY_DEPS="$(grep -o '"name"' <<<"${body}" | wc -l | tr -d ' ')"
    item "✅" "$(fmt_ms "${STAGE_MS[api_ready]}")（${READY_DEPS} 项依赖全 up）"
  else
    fail=1
    case "${rc}" in
      2) item "❌" "API 进程提前退出，日志尾部：" ;;
      3) item "❌" "${READY_TIMEOUT}s 内未就绪（六依赖有 down 时 /health/ready 是 503），日志尾部：" ;;
      *) item "❌" "未就绪，日志尾部：" ;;
    esac
    tail -n 15 "${log}" | sed 's/^/      /'
  fi
  cleanup
}

echo "DX 基线测量（${REPO_ROOT}，模式 ${MODE}，${STAMP}）"
echo

if [[ "${MODE}" == cold ]]; then
  run_stage "reset" "docker compose down -v（删卷）" \
    docker compose --project-directory . -f infra/compose/compose.yml down -v
  printf '▶ %-10s %s\n' "rm_modules" "删除 node_modules（保留 pnpm store）"
  find . -name node_modules -maxdepth 3 -type d -prune -exec rm -rf {} +
  item "✅" "已删除"
fi

run_stage "install" "pnpm install --frozen-lockfile" pnpm install --frozen-lockfile
if [[ "${RUN_VERIFY}" -eq 1 ]]; then
  run_stage "verify" "pnpm run verify 全链" pnpm run verify
fi
run_stage "infra_up" "pnpm run infra:up（含 preflight）" pnpm run infra:up
run_stage "bootstrap" "pnpm run bootstrap（幂等）" pnpm run bootstrap
stage_api_ready

# ── 汇总 ───────────────────────────────────────────────────────────────
sum_ms() {
  local total=0 name
  for name in "$@"; do
    total=$((total + ${STAGE_MS[${name}]:-0}))
  done
  printf '%s' "${total}"
}

all_ok() {
  local name
  for name in "$@"; do
    [[ "${STAGE_RC[${name}]:-1}" -eq 0 ]] || return 1
  done
}

# TTHW 只在三个阶段都成功时才有意义；失败时记 -1，不给一个看起来很快的假数。
TTHW_MS=-1
TTHW_FROM_INSTALL_MS=-1
if all_ok infra_up bootstrap api_ready; then
  TTHW_MS="$(sum_ms infra_up bootstrap api_ready)"
  if all_ok install; then
    TTHW_FROM_INSTALL_MS="$((${STAGE_MS[install]:-0} + TTHW_MS))"
  fi
fi

TEST_FILES=""
TESTS=""
if [[ -f "${LOG_DIR}/verify.log" ]]; then
  TEST_FILES="$(sed -n 's/.*Test Files *\([0-9]\{1,\}\) passed.*/\1/p' "${LOG_DIR}/verify.log" | tail -n 1)"
  TESTS="$(sed -n 's/.*Tests *\([0-9]\{1,\}\) passed.*/\1/p' "${LOG_DIR}/verify.log" | tail -n 1)"
fi

# 目标未达成的计数在主 shell 里算：判定函数在 $( ) 里跑，改不动外层变量。
verify_missed=0
tthw_missed=0
if [[ "${STAGE_RC[verify]:-1}" -eq 0 && "${STAGE_MS[verify]:-0}" -gt "${TARGET_VERIFY_MS}" ]]; then
  verify_missed=1
fi
if [[ "${TTHW_MS}" -lt 0 || "${TTHW_MS}" -gt "${TARGET_TTHW_MS}" ]]; then
  tthw_missed=1
fi
warn_count=$((verify_missed + tthw_missed))

mark_for() {
  local ms="$1" target="$2"
  if [[ "${ms}" -lt 0 ]]; then
    printf '❌'
  elif [[ "${ms}" -le "${target}" ]]; then
    printf '✅'
  else
    printf '⚠️'
  fi
}

echo
echo "结果"
# 表头手工对齐：CJK 是双宽字符，printf 的 %-10s 按字符/字节补位，对不齐。
printf '  阶段       耗时      目标       判定\n'
for name in "${STAGE_ORDER[@]}"; do
  stage_ms="${STAGE_MS[${name}]}"
  mark="✅"
  target="—"
  if [[ "${STAGE_RC[${name}]}" -ne 0 ]]; then
    mark="❌"
  elif [[ "${name}" == verify ]]; then
    target="≤$(fmt_ms "${TARGET_VERIFY_MS}")"
    mark="$(mark_for "${stage_ms}" "${TARGET_VERIFY_MS}")"
  fi
  printf '  %-10s %-9s %-10s %s\n' "${name}" "$(fmt_ms "${stage_ms}")" "${target}" "${mark}"
done
if [[ "${TTHW_MS}" -ge 0 ]]; then
  tthw_text="$(fmt_ms "${TTHW_MS}")"
else
  tthw_text="n/a"
fi
printf '  %-10s %-9s %-10s %s\n' "TTHW" "${tthw_text}" "<$(fmt_ms "${TARGET_TTHW_MS}")" \
  "$(mark_for "${TTHW_MS}" "${TARGET_TTHW_MS}")"
echo "  TTHW = infra_up + bootstrap + api_ready（含 install 则 $(
  [[ "${TTHW_FROM_INSTALL_MS}" -ge 0 ]] && fmt_ms "${TTHW_FROM_INSTALL_MS}" || printf 'n/a'
)）"
if [[ -n "${TESTS}" ]]; then
  echo "  测试：${TEST_FILES} 个文件 / ${TESTS} 条通过"
fi

# ── 机读结果（供 boomerang 前后对比）────────────────────────────────────
json_stages=""
for name in "${STAGE_ORDER[@]}"; do
  [[ -z "${json_stages}" ]] || json_stages+=","
  json_stages+=$'\n    '"{\"name\": \"${name}\", \"ms\": ${STAGE_MS[${name}]}, \"exitCode\": ${STAGE_RC[${name}]}}"
done

cat > "${OUT_FILE}" <<JSON
{
  "measuredAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "mode": "${MODE}",
  "commit": "$(git -C "${REPO_ROOT}" rev-parse --short HEAD 2>/dev/null || echo unknown)",
  "host": "$(uname -sr)",
  "node": "$(node --version 2>/dev/null || echo unknown)",
  "pnpm": "$(pnpm --version 2>/dev/null || echo unknown)",
  "stages": [${json_stages}
  ],
  "tthwMs": ${TTHW_MS},
  "tthwFromInstallMs": ${TTHW_FROM_INSTALL_MS},
  "readyDependencies": ${READY_DEPS},
  "tests": { "files": ${TEST_FILES:-null}, "cases": ${TESTS:-null} },
  "targets": { "verifyMs": ${TARGET_VERIFY_MS}, "tthwMs": ${TARGET_TTHW_MS} },
  "t0Reference": {
    "note": "T0（2026-08-28）手工实测，热态",
    "installMs": 680,
    "verifyMs": 19100,
    "infraUpMs": 880,
    "bootstrapMs": 5100,
    "tthwMs": 240000
  },
  "failed": ${fail},
  "targetsMissed": ${warn_count}
}
JSON

echo
echo "JSON：${OUT_FILE}"
echo "日志：${LOG_DIR}/"

if [[ "${fail}" -ne 0 ]]; then
  echo "有阶段失败，见上面的日志尾部。" >&2
  exit 1
fi
if [[ "${warn_count}" -gt 0 ]]; then
  echo "全部阶段通过，${warn_count} 项未达目标耗时（加 --strict 可按失败处理）。"
  [[ "${STRICT}" -eq 0 ]] || exit 1
else
  echo "全部阶段通过且达成目标耗时。"
fi
