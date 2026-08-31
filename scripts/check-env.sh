#!/usr/bin/env bash
# 环境预检（devex 评审 DX-T2，并入 T1a）。
#
# 在 infra:up / bootstrap / dev 之前检查本地工具链缺项，给出修复指引而不是
# 让开发者面对 docker 或 node 的原始报错。幂等、只读、退出码：
#   0 全部就绪（可能有 ⚠️ 可选缺项）；1 存在阻断缺项（stderr 有逐项修复指引）。
#
# 阻断与可选的判据：起不了本地主链的才算阻断。infra:up 依赖本脚本的退出码，
# 因此"只跑 API/Web 可跳过"的东西必须是 ⚠️ 而不是 ❌——文案说可选、退出码说必需，
# 是最难自查的一类环境问题。
set -Eeuo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${HERE}/.." && pwd)"

fail=0
warn_count=0
item() { printf '  %s %s\n' "$1" "$2"; }
need() { item "❌" "$1"; }
warn() {
  item "⚠️" "$1"
  warn_count=$((warn_count + 1))
}
have() { item "✅" "$1"; }

echo "环境预检（${REPO_ROOT}）"

# ── Node.js ────────────────────────────────────────────────────────────
if command -v node >/dev/null 2>&1; then
  node_version="$(node --version 2>/dev/null || echo unknown)"
  # .nvmrc 缺失时不能让 tr 在 set -e 下把脚本打死：这正是本脚本该解释的情形。
  if [[ -f "${REPO_ROOT}/.nvmrc" ]]; then
    want_node="v$(tr -d '[:space:]' < "${REPO_ROOT}/.nvmrc")"
  else
    want_node=""
  fi
  if [[ -z "${want_node}" ]]; then
    need ".nvmrc 缺失或为空：无法校验 Node 版本（当前 ${node_version}）；从 git 恢复该文件"
    fail=1
  elif [[ "${node_version}" == "${want_node}" ]]; then
    have "Node.js ${node_version}"
  else
    need "Node.js 版本 ${node_version}，仓库锁定 ${want_node}（nvm：nvm install && nvm use；版本见 .nvmrc）"
    fail=1
  fi
else
  need "Node.js 未安装：安装 22.23.1（https://nodejs.org 或 nvm install 22.23.1）"
  fail=1
fi

# ── pnpm ───────────────────────────────────────────────────────────────
if command -v pnpm >/dev/null 2>&1; then
  pnpm_version="$(pnpm --version 2>/dev/null || echo unknown)"
  want_pnpm="$(sed -n 's/.*"packageManager": "pnpm@\([^"]*\)".*/\1/p' "${REPO_ROOT}/package.json")"
  if [[ "${pnpm_version}" == "${want_pnpm}" ]]; then
    have "pnpm ${pnpm_version}"
  else
    need "pnpm 版本 ${pnpm_version}，仓库锁定 ${want_pnpm}（corepack enable && corepack install）"
    fail=1
  fi
else
  need "pnpm 未安装：corepack enable（Node 22 自带 corepack）"
  fail=1
fi

# ── uv（Python 工具链，仅 Parser/评测需要，不阻断本地主链）─────────────
if command -v uv >/dev/null 2>&1; then
  have "uv $(uv --version 2>/dev/null | awk '{print $2}')"
else
  warn "uv 未安装：curl -LsSf https://astral.sh/uv/install.sh | sh（Parser 与评测需要；只跑 API/Web 可跳过，不阻断 infra:up）"
fi

# ── Docker daemon ──────────────────────────────────────────────────────
if command -v docker >/dev/null 2>&1; then
  if docker info >/dev/null 2>&1; then
    have "Docker daemon 运行中"
  else
    need "Docker daemon 未运行：启动 Docker Desktop（WSL2：确认 Docker Desktop 已启动并开启 WSL 集成），或 sudo systemctl start docker"
    fail=1
  fi
else
  need "Docker 未安装：安装 Docker Engine 与 Compose v2（https://docs.docker.com/engine/install/）"
  fail=1
fi

# ── Compose v2 ─────────────────────────────────────────────────────────
if docker compose version >/dev/null 2>&1; then
  have "Docker Compose v2 可用"
else
  need "Docker Compose v2 不可用：安装或更新 docker-compose-plugin（https://docs.docker.com/compose/install/）"
  fail=1
fi

# ── .env ───────────────────────────────────────────────────────────────
if [[ -f "${REPO_ROOT}/.env" ]]; then
  have ".env 已存在（应用启动时会自动预载，无需手工 source）"
else
  need ".env 缺失：cp .env.example .env（本地默认值即可启动，不要提交真实密钥）"
  fail=1
fi

echo
if [[ "${fail}" -eq 0 ]]; then
  if [[ "${warn_count}" -gt 0 ]]; then
    echo "环境预检通过（${warn_count} 项可选工具缺失，只影响 Parser/评测链路）。"
  fi
  echo "环境预检通过。黄金路径：pnpm run infra:up && pnpm run bootstrap && pnpm --filter @rag/api dev"
else
  echo "存在缺项，按上面的指引修复后重跑：bash scripts/check-env.sh" >&2
  exit 1
fi
