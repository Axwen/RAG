# Web RAG 边界与依赖

## 1. 依赖矩阵

| 依赖 | Web RAG 是否拥有 | 是否跨仓库共享 | 说明 |
|---|---:|---:|---|
| `packages/contracts` 语义类型 | 是（当前事实源） | 语义共享 | 不共享数据库 schema |
| `packages/rag-core` 纯逻辑 | 是（当前实现） | 行为/测试向量共享 | Rust 端可移植等价实现，不强行依赖 Node |
| PostgreSQL/Prisma | 是 | 否 | Web 业务事实、任务、授权和审计 |
| OpenSearch | 是 | 否 | Web 检索投影 |
| RabbitMQ/Outbox | 是 | 否 | Web 异步任务实现 |
| object storage adapter | 是 | 否 | Web Artifact 和回答快照 |
| Keycloak/业务授权 | 是 | 否 | Web 企业身份和权限 |
| `scene-core` | 消费者 | 协议共享 | 固定 tag/SHA，通过 Adapter 调用 |
| AI Provider SDK | Adapter 拥有 | 能力语义共享 | 供应商 SDK 不进入公共核心 |
| Tauri/SQLite/本地 Worker | 否 | 否 | 由 `scene-seek` 拥有 |

## 2. 明确的禁止依赖

`packages/rag-core` 和 `packages/contracts` 不得依赖：

```text
Prisma / PostgreSQL / OpenSearch / RabbitMQ / SQLite
FFmpeg / FFprobe / Tauri / 具体模型 SDK
```

Web 可以依赖 `MediaEngineAdapter`，但 Adapter 不能把引擎的临时路径、FFmpeg 参数或进程句柄泄漏到公共领域类型。

## 3. Web 媒体入库的所有权

```text
授权与生命周期       Web RAG
媒体机械处理         scene-core
AI 分析与模型路由    Web AI Adapter
证据/索引/发布       Web RAG
```

这意味着同一个视频在 Web 侧的“已入库”不能仅由引擎返回成功决定；必须完成 Web 自己的持久化、Evidence、索引和发布门禁。

## 4. 何时允许扩大 Web 边界

只有在后续有真实实现和评测证据时，才允许加入：

- Web Video RAG 任务和 API；
- Media Engine Worker Pool 或服务化；
- Web 侧视觉索引和时间线查询；
- Web 与桌面之间的数据导入/导出协议。

届时必须新增/修订 ADR、更新兼容矩阵和 readiness gate，不通过增加一个 `video_url` 字段或复制桌面数据库来“接入视频”。
