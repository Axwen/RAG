# PROBE-000：Docker CE 探针运行环境门禁

## 目的

确认六个架构探针具备可运行的本地环境。该门禁不验证业务协议，只判断工具链、Docker CE Engine、Compose 插件、资源边界和云模型凭据是否满足执行条件。

## 本次检查结果

执行日期：2026-08-25（用户终端复检）

| 检查项 | 结果 | 证据 |
|---|---|---|
| Node.js | PASS | v22.23.1 |
| pnpm | PASS | v10.34.5 |
| Python | PASS | 3.12.3 |
| Docker CE CLI | PASS | Docker Engine - Community CLI v29.7.2 可用 |
| Docker Engine/API | PASS | 用户 WSL 终端 `docker info` 成功；Engine v29.7.2 |
| Docker Socket | PASS | 用户 WSL 终端可访问 `/var/run/docker.sock` |
| Docker Compose | PASS | Compose plugin v5.5.0 可用 |
| Docker Engine memory | PASS_WITH_ADJUSTMENT | Engine 可见 23.47 GiB，超过日常 22 GiB，略低于 Parser 建议 24 GiB |
| 云模型凭据（OpenRouter / fluxionai） | NOT CHECKED | 不读取或输出任何 Secret；由 PROBE-005 使用时检查 |

## 解除条件

Docker CE 不依赖 Docker Desktop。请确认 Docker daemon 已启动，并让当前用户能够访问 Docker Socket（通常将用户加入 `docker` 组后重新登录）。然后执行：

docker version
docker compose version
docker info

然后重新运行：

scripts/probes/preflight.sh

## 判定

- 当前状态：PASS_WITH_ADJUSTMENT（Docker CE 运行时和日常资源通过，Parser 资源略低于建议值）
- PROBE-001 至 PROBE-006 可以开始执行；PROBE-002/006 的资源峰值结论必须标记为 23.47 GiB profile，不外推到完整 24 GiB 配置。
- PROBE-005 需要云模型凭据（OpenRouter Embedding、fluxionai Chat，见 ADR-0017）和网络条件，不能因为本地工具链通过而自动标记通过。
- 如需完整 Parser 余量，再提高到 24 GiB 后重跑 PROBE-002/006；不需要修改架构计划或 Tickets。
