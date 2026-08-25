---
status: superseded
superseded-by: 0015-aliyun-oss-and-resource-aware-compose.md
---

# MVP 使用完整目标中间件链路

流程验证 MVP 原计划在 Docker Compose 中同时启用 PostgreSQL、OpenSearch、Redis、MinIO 和 Keycloak，以验证业务事实、混合检索、异步队列、对象存储和身份认证的真实集成。开发环境和可用云资源确认后，本决策由 ADR 0015 替代：核心中间件仍使用真实服务，但对象存储默认接入阿里云 OSS，MinIO、Parser 和观测栈改为按需 Profile。
