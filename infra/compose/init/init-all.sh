#!/usr/bin/env bash
# 一键幂等初始化本地环境。假定 core 中间件已经 healthy（先执行 pnpm run infra:up）。
#
# 顺序：Keycloak Realm -> MinIO Bucket -> 数据库迁移与种子。
# 每一步都可以单独重跑，整体也可以重复执行而不产生重复副作用。
set -Eeuo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${HERE}/lib.sh"

load_env

log "检查 core 中间件状态"
core_services=(postgres opensearch rabbitmq redis minio keycloak)
for service in "${core_services[@]}"; do
  container_id="$(compose ps -q "${service}" 2>/dev/null || true)"
  if [[ -z "${container_id}" ]]; then
    die "core 中间件 ${service} 未启动；先执行 pnpm run infra:up"
  fi

  state="$(docker inspect --format '{{.State.Status}}' "${container_id}" 2>/dev/null || true)"
  health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "${container_id}" 2>/dev/null || true)"
  if [[ "${state}" != "running" || "${health}" != "healthy" ]]; then
    die "core 中间件 ${service} 尚未 healthy（state=${state:-unknown}, health=${health:-unknown}）；先等待 pnpm run infra:up 完成"
  fi
done

bash "${HERE}/init-keycloak.sh"
bash "${HERE}/init-minio.sh"
bash "${HERE}/init-database.sh"

log "本地环境初始化完成。可重复执行本脚本。"
