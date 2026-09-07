# Web RAG 仓库规划包

> 当前仓库就是 Web RAG 仓库。本目录不是要再创建一个 `web-rag` 仓库，而是把它在三仓库架构中的职责和未来媒体接入资料单独归档，便于与其他两个仓库的资料对照。

## 1. 负责什么

- Web UI 和用户交互；
- NestJS/Node 控制面、任务编排和 Web Worker；
- PostgreSQL/Prisma 业务事实、任务、审核、Release、审计和删除；
- OpenSearch 候选索引与检索 Adapter；
- RabbitMQ + Outbox 的异步任务传递；
- object storage adapter（当前本地 MinIO，未来可替换云对象存储）；
- Keycloak/OIDC 与业务授权；
- Python Parser Service 和服务端 Python/Node AI Adapter；
- 公共 `packages/contracts`、`packages/rag-core` 和评测格式；
- 未来 Web Video RAG 的 `MediaEngineAdapter`，但不实现媒体引擎本身。

## 2. 不负责什么

- Rust Media Engine 的实现；
- FFmpeg/FFprobe 进程管理和媒体编解码；
- Tauri、SQLite WAL、本地文件监控和桌面 UI；
- 让浏览器直接调用 FFmpeg 或 AI Provider；
- 把视频强行映射成一个文档或一个全局向量字段；
- 创建独立 `video-rag-service`。

## 3. 相关文档

- [职责说明](responsibilities.md)
- [未来媒体接入方式](media-integration.md)
- [边界与依赖](boundaries.md)
- [ADR-0045](../../../adr/0045-shared-media-engine-and-three-repository-boundary.md)
- [跨仓库公共契约](../cross-repository-contracts.md)
- [当前公共契约 Spec](../../../engineering/video-rag-public-contract-spec.md)
- [当前 `rag-core` Spec](../../../engineering/video-rag-rag-core-spec.md)
