#!/usr/bin/env bash
# 幂等创建本地 MinIO Bucket。
#
# 用固定版本的 mc 一次性容器接入 Compose 网络，不要求宿主安装 mc。
# `mb --ignore-existing` 天然幂等；版本控制策略与保留策略不在 T0 范围。
set -Eeuo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

load_env
require_env MINIO_ROOT_USER MINIO_ROOT_PASSWORD
: "${MINIO_BUCKET:=rag-local}"

MC_IMAGE="minio/mc:RELEASE.2025-08-13T08-35-41Z"
NETWORK="$(compose_network)"

mc() {
  docker run --rm --network "${NETWORK}" \
    -e MC_HOST_local="http://${MINIO_ROOT_USER}:${MINIO_ROOT_PASSWORD}@minio:9000" \
    "${MC_IMAGE}" "$@"
}

log "在网络 ${NETWORK} 上创建 Bucket ${MINIO_BUCKET}"
mc mb --ignore-existing "local/${MINIO_BUCKET}" ||
  die "创建 Bucket 失败；确认 core 服务已 healthy（pnpm run infra:up）"

mc ls "local/${MINIO_BUCKET}" >/dev/null || die "Bucket ${MINIO_BUCKET} 创建后不可访问"

log "MinIO 初始化完成：bucket=${MINIO_BUCKET}"
