#!/usr/bin/env bash
# Parser 镜像的启动验证：真起容器，等它自己的 HEALTHCHECK 变 healthy，再从宿主机打一次
# /health/live。
#
# 为什么需要：CI 的 compose job 和 release.yml 此前都只 `docker build`，从没 `docker run`
# 过。构建成功只证明依赖装得上，不证明 CMD 起得来——缺了模块入口、非 root 用户读不到
# /opt/venv、EXPOSE 的端口没人监听，这些全都能构建通过然后在第一次拉起时失败。
# 镜像会被推到 GHCR 供人拉取，"能拉但起不来"的产物比构建失败更糟。
#
# 用法：bash scripts/check-parser-image.sh <image-ref>
#   本地/CI 构建产物：bash scripts/check-parser-image.sh rag-parser:ci
#   推送后的摘要：    bash scripts/check-parser-image.sh ghcr.io/owner/repo/parser@sha256:...
set -Eeuo pipefail

IMAGE="${1:?用法: check-parser-image.sh <image-ref>}"
NAME="parser-imgcheck-$$"
PORT="${PARSER_CHECK_PORT:-18100}"
BUDGET="${PARSER_CHECK_BUDGET:-90}" # 秒；镜像 HEALTHCHECK 的 start-period 是 20s

cleanup() {
  local code=$?
  if [[ "${code}" -ne 0 ]]; then
    echo "::group::容器日志（${NAME}）"
    docker logs "${NAME}" 2>&1 | tail -n 100 || true
    echo "::endgroup::"
    echo "::group::容器状态"
    docker inspect --format '{{json .State}}' "${NAME}" 2>/dev/null || true
    echo "::endgroup::"
  fi
  docker rm -f "${NAME}" >/dev/null 2>&1 || true
  exit "${code}"
}
trap cleanup EXIT

echo "▶ 起容器 ${IMAGE}（宿主端口 ${PORT}）"
docker run -d --name "${NAME}" -p "127.0.0.1:${PORT}:8100" "${IMAGE}" >/dev/null

# 1. 等镜像自带的 HEALTHCHECK：这一步同时验证了 HEALTHCHECK 指令本身是对的
deadline=$((SECONDS + BUDGET))
status='(none)'
while [[ "${SECONDS}" -lt "${deadline}" ]]; do
  # 先看进程活着没有，再看健康状态：容器退出时 HEALTHCHECK 也会被记成 unhealthy，
  # 顺序反了就会把"进程压根没起来"报成"健康检查失败"，指向完全不同的排查方向
  if [[ "$(docker inspect --format '{{.State.Running}}' "${NAME}" 2>/dev/null)" != 'true' ]]; then
    echo "❌ 容器已退出（exit $(docker inspect --format '{{.State.ExitCode}}' "${NAME}" 2>/dev/null)）" >&2
    exit 1
  fi
  status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "${NAME}" 2>/dev/null || echo unknown)"
  case "${status}" in
    healthy) break ;;
    unhealthy)
      echo "❌ 容器还在运行，但 HEALTHCHECK 报 unhealthy" >&2
      exit 1
      ;;
  esac
  sleep 2
done

if [[ "${status}" != 'healthy' ]]; then
  echo "❌ ${BUDGET}s 内未变 healthy（当前 ${status}）" >&2
  exit 1
fi
echo "✅ HEALTHCHECK healthy"

# 2. 从宿主机再打一次：验证 EXPOSE/端口映射对外真的可达，而不只是容器内自测通过
code="$(curl -fsS -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:${PORT}/health/live" || echo 000)"
if [[ "${code}" != '200' ]]; then
  echo "❌ 宿主机请求 /health/live 得到 ${code}（期望 200）" >&2
  exit 1
fi
echo "✅ 宿主机 /health/live -> 200"
echo "✅ 镜像启动验证通过：${IMAGE}"
