# PROBE-000：Docker CE 探针运行环境门禁

## 目的

确认六个架构探针具备可运行的本地环境。该门禁不验证业务协议，只判断工具链、Docker CE Engine、Compose 插件、资源边界和云模型凭据是否满足执行条件。

## 本次检查结果

执行日期：2026-08-25（复检）

| 检查项 | 结果 | 证据 |
|---|---|---|
| Node.js | PASS | v22.23.1 |
| pnpm | PASS | v10.34.5 |
| Python | PASS | 3.12.3 |
| Docker CE CLI | PASS | Docker Engine - Community CLI v29.7.2 可用 |
| Docker Engine/API | BLOCKED | 当前 Codex 执行环境访问 `unix:///var/run/docker.sock` 被拒绝；沙箱外执行审批服务返回 503 |
| Docker Socket | BLOCKED | `/var/run/docker.sock` 存在，但当前 Codex 执行环境无权访问 Docker API |
| Docker Compose | PASS | Compose plugin v5.5.0 可用；因 Engine API 权限问题尚不能启动容器 |
| 百炼凭据 | NOT CHECKED | 不读取或输出任何 Secret；由 PROBE-005 使用时检查 |

## 解除条件

Docker CE 不依赖 Docker Desktop。请确认 Docker daemon 已启动，并让当前用户能够访问 Docker Socket（通常将用户加入 `docker` 组后重新登录）。然后执行：

docker version
docker compose version
docker info

然后重新运行：

scripts/probes/preflight.sh

## 判定

- 当前状态：BLOCKED_ENVIRONMENT（Docker CE Engine API 权限）
- 不能把 PROBE-001 至 PROBE-004 标记为通过。
- PROBE-005 需要百炼凭据和网络条件，不能因为本地工具链通过而自动标记通过。
- 环境恢复后，不需要修改架构计划或 Tickets，只需重新执行门禁并开始 PROBE-001、PROBE-002、PROBE-003。
