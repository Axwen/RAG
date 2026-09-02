#!/usr/bin/env bash
# 幂等应用数据库迁移并写入最小开发种子。
#
# 迁移用 prisma migrate deploy（幂等：已应用的迁移会被跳过），不用 db push。
# T1a 起有领域模型、迁移与开发种子；种子按固定 UUID upsert，可重复执行。
set -Eeuo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

load_env
require_env DATABASE_URL

cd "${REPO_ROOT}"

log "应用数据库迁移（prisma migrate deploy）"
pnpm --filter @rag/database run migrate:deploy || die "数据库迁移失败"

migration_dir="${REPO_ROOT}/packages/database/prisma/migrations"
if [[ -d "${migration_dir}" ]] && compgen -G "${migration_dir}/*/migration.sql" >/dev/null; then
  # seed 是 Node 程序，import 的是 @rag/contracts 等工作区包的**编译产物**。全新克隆里
  # packages/*/dist 还不存在——`pnpm install` 的 postinstall 只跑 prisma generate，不构建。
  # 于是 README 黄金路径（install → infra:up → bootstrap）在新环境上必然死在这里：
  #   Cannot find module '.../packages/database/node_modules/@rag/contracts/dist/index.js'
  # 本地一直不复现，只因为 dist 是历次 build 留下的。CI 首跑（干净 checkout）当场红。
  #
  # 修法是让 bootstrap 自给自足，而不是往 README 里加一步 build：bootstrap 对外的承诺
  # 就是"一条命令、可重复执行"，把前置条件推给读者等于把这个坑留给下一个新人。
  # --filter "...@rag/database"：前置 ... 是"该包及其工作区依赖"（后置 ... 才是依赖方），
  # 这里选中 database + contracts + observability 三个，不碰 apps/web。
  # tsc -b 增量，已构建时接近零成本，重复执行安全。
  log "构建 seed 依赖的工作区包（tsc -b 增量）"
  pnpm --filter "...@rag/database" run build || die "工作区包构建失败；seed 依赖 packages/*/dist"

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
