---
status: accepted
date: 2026-09-04
revises:
  - 0024-rabbitmq-asynchronous-task-bus.md
  - 0038-vlm-parser-backend-and-multimodal-scope.md
decision-basis: Video RAG 公共基座架构 Review；本地优先与 Web 企业运行时并存要求
---

# ProviderRun、JobEvent 与 Web/本地运行时适配边界

## 背景

现有 Web RAG 的 PostgreSQL、RabbitMQ、OpenSearch、MinIO、Keycloak 设计适合企业控制面和异步文档链路；本地 Video RAG 需要 SQLite WAL、本地 Artifact Store 和本地 Worker。两者共享语义协议，不共享数据库、消息队列、文件存储或部署拓扑。

## 决策

1. 公共契约新增 `ProviderArtifact`、`ProviderRun` 和 `JobEvent`，以表达 `probe`、`media_extract`、`segmentation`、`subtitle`、`speech`、`ocr`、`visual_embedding`、`caption`、`text_embedding`、`rerank`、`generation` 和 `citation_verification` 等任务族。
2. 每个分析结果必须可关联 `sourceVersionId`、`providerRef`、`providerVersion`、`modelRef`、`modelVersion`、`inputFingerprint`、`outputFingerprint`、`runId`、`generation` 和 `attempt`。
3. ProviderRun 的状态至少支持 `queued`、`running`、`retrying`、`succeeded`、`failed`、`cancelled`、`expired` 和 `superseded`。Projection/Index 的生命周期独立管理，不能把所有状态压成 Asset 上的一列。
4. 结果写回必须在副作用前检查：来源版本、当前 Generation、InputFingerprint、Run 身份一致，Run 未取消或 superseded，且 Attempt 仍是当前允许写回的 Attempt。任何条件失败都拒绝写回。
5. Web Adapter 继续使用 PostgreSQL 事实源、RabbitMQ 投递、MinIO Artifact、OpenSearch 投影和 Keycloak/业务授权；本地 Adapter 使用 SQLite WAL、本地文件 Artifact Store 和本地 Worker Supervisor。公共契约不暴露连接、路径、FFmpeg argv 或模型进程句柄。
6. 视频 Provider 是独立 Provider/Job 族，不接入 `services/parser` 的 DeepDOC 后端；ADR-0038 的文档图片 OCR/Office 混合解析边界保持不变。
7. 本轮不创建独立 `video-rag-service`，不将 SQLite、FFmpeg、ASR、OCR、VLM 或 Tauri 引入 Web RAG 公共核心。

## 不变量

- `sourceVersionId` 或 `inputFingerprint` 不一致时，即使 Provider/model 版本相同也拒绝旧结果写回。
- `generation` 不一致时，旧结果不能更新当前索引、Evidence 可用性或 Release。
- `cancelled`/`superseded` Run 不得改变当前索引；取消是业务状态事实，不等于只发一个进程信号。
- 重试创建新的 Attempt 或新的 Run 事实，不覆盖之前失败的结果和事件。
- JobEvent 按 `jobId + sequence`（或等价的 Adapter 唯一键）可排序、可去重；事件载荷只放受控元数据，不放媒体二进制、密钥或模型思维链。

## 与既有 ADR 的关系

- ADR-0024 的 RabbitMQ、Outbox、ACK、重试、DLQ 和不宣称 exactly-once 继续适用于 Web Adapter；本文不把 RabbitMQ 扩大为公共依赖。
- ADR-0038 继续约束文档 Parser Service 的 DeepDOC/OCR/Office 路由；视频处理另走 Provider/Job seam。
