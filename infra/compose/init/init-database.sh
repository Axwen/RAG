#!/usr/bin/env bash
# 幂等应用数据库迁移并写入最小开发种子。
#
# 迁移用 prisma migrate deploy（幂等：已应用的迁移会被跳过），不用 db push。
# T0 没有领域模型，因此没有迁移也没有种子行；这是 T0 的显式状态，不是脚本失败。
set -Eeuo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

load_env
require_env DATABASE_URL

cd "${REPO_ROOT}"

log "应用数据库迁移（prisma migrate deploy）"
pnpm --filter @rag/database run migrate:deploy || die "数据库迁移失败"

migration_dir="${REPO_ROOT}/packages/database/prisma/migrations"
if [[ -d "${migration_dir}" ]] && compgen -G "${migration_dir}/*/migration.sql" >/dev/null; then
  log "开发种子：领域种子随对应票据加入，当前按已有迁移执行 seed 脚本（如有）"
  if pnpm --filter @rag/database run --if-present seed; then
    log "开发种子完成"
  else
    warn "seed 脚本存在但执行失败"
    exit 1
  fi
else
  log "开发种子：T0 无领域模型与迁移，种子为空（领域种子随 T1a 起加入）"
fi

log "数据库初始化完成"
