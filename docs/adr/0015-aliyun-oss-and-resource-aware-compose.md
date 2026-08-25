---
status: superseded
supersedes: 0012-full-compose-middleware-for-mvp.md
superseded-by: 0016-local-minio-for-development.md
---

# 使用阿里云 OSS 和资源分级 Compose

流程验证 MVP 原计划默认使用阿里云 OSS 保存原文件、解析产物和引用快照。经开发资源确认后，默认开发存储由 ADR 0016 调整为本地 MinIO；阿里云 OSS 仍作为云端兼容和试点存储。

开发环境为 WSL2、12 核 CPU、32 GiB 主机内存，WSL2 日常建议上限 22 GiB、峰值可调至 24 GiB。默认 Compose 启动 PostgreSQL、单节点 OpenSearch、Redis、Keycloak 及应用服务，OpenSearch JVM 初始限制为 2 GiB；DeepDOC Parser 和 OpenTelemetry/Grafana/Loki/Tempo 使用独立 Profile 按需启动。该资源规格足以完成云模型驱动的 MVP 开发和小规模黄金集评测，但不用于本地大模型、生产容量验证或全组件并发压测。
