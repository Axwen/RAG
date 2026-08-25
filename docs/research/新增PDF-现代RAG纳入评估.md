# 新增 PDF：现代 RAG 纳入评估

> 日期：2026-08-21  
> 目的：将新增项目材料转化为当前 TypeScript 可信 RAG 方案中的可验证能力，避免照搬教学项目的中间件和安全配置。

## 结论

新增材料补强了四条主链路：

1. 异步索引投影：文档级稀疏索引、块级向量/稀疏索引和未来图谱投影并行构建；新版本先构建隔离候选 Release，审核通过后再激活，避免发布后的检索空窗。
2. 审核与处理状态分离：`Draft -> PendingReview -> Published -> Archived` 不等于解析/索引任务状态。
3. 多格式解析统一契约：PDF、DOCX、PPTX、XLSX 等都产出 Markdown + 结构化块 + 原文定位，而不是只留下扁平文本。
4. 图谱作为有出处的可选证据通道：`Document -> Chunk -> Entity` 保留溯源，只有多跳黄金题证明收益后才启用 Neo4j。

当前方案吸收这些数据流和治理原则，并采用 RabbitMQ 作为 P0 异步任务总线；但不照搬材料中的默认凭据、简单发布后消费模型或 Elasticsearch/RustFS/MongoDB/Neo4j 部署方式。

## 逐份材料核对

| 材料 | 页码证据 | 纳入现代 RAG 的能力 | 当前决策 |
|---|---|---|---|
| [全文检索链路](<../../pdf/企业级知识库项目：全文检索链路.pdf>) | 第 1 页：发布后 RAG/Search/KG 三消费者；第 6–10 页：新增、删除和双层索引同步 | 文档级过滤/聚合 + chunk 级精确召回；发布、更新、删除事件驱动；tombstone 和索引 alias | P0；OpenSearch 统一承载，不新增 Elasticsearch |
| [基于消息队列的异步 RAG 流水线](<../../pdf/企业级知识库项目：基于消息队列的异步 RAG 流水线.pdf>) | 第 1–2 页：发布后并行消费者；第 5–11 页：分块、Embedding、向量索引和消费测试 | Outbox、幂等消费者、部分成功、重试、DLQ、背压；消息只传版本/快照 ID | P0；使用 PostgreSQL Outbox + RabbitMQ，Redis 不再承担任务队列 |
| [文档审核机制、四种状态流转](<../../pdf/企业级知识库项目：文档审核机制、四种状态流转.pdf>) | 第 1–3 页：四态和流转；第 4–10 页：审核记录、边界和索引清理测试 | 审核状态机、审核历史、发布前检查、归档和撤回的索引失效 | P0；与 processing/index 状态正交，发布采用新批次切 alias |
| [文档抽取 Neo4j 知识图谱的实体](<../../pdf/企业级知识库项目：文档抽取 Neo4j知识图谱的实体.pdf>) | 第 3–5 页：Document/Chunk/Entity；第 6–12 页：实体关系、溯源和删除 | 实体/关系来源、置信度、抽取版本、审核状态和多跳证据 | P1；MVP 只预留 GraphProjectionAdapter，不启动 Neo4j |
| [PPTX 文件解析为 md 文档](<../../pdf/PPTX 文件解析为 md 文档.pdf>) | 第 1–8 页：PDF/XLSX/DOCX/PPTX 统一解析；第 9–11 页：对象存储和端到端测试 | Parser Adapter、Markdown + block JSON 双产物；slide/shape/sheet/cell provenance | P0；纳入 Office 解析契约，复杂图表和讲者备注后续增强 |

## 不照搬的配置和原因

新增材料中的本地 Compose 示例用于教学验证，不能直接作为本项目的现代化默认配置：

- RabbitMQ `guest/guest`：仅拒绝材料中的默认凭据和简单配置；本项目仍使用 RabbitMQ，但采用独立 vhost/用户、最小权限、持久化队列、Publisher Confirm、manual ACK、TTL + DLX 重试和 DLQ。
- Elasticsearch/Kibana 关闭安全认证和 TLS：仅能用于隔离的本地演示，不能进入试点配置。
- Neo4j `latest`、明文密码和 unrestricted APOC：版本不可复现、权限过宽，且图谱尚未证明 MVP 价值。
- MongoDB 与 PostgreSQL 双写正文：会引入跨库一致性、备份和恢复复杂度；当前正文和解析产物按 Prisma/MinIO 边界处理。
- RustFS：可以作为 S3 兼容对象存储参考，但当前本地对象存储已经确认使用 MinIO。

## 对当前实现设计的直接影响

### P0

- `document_version`、`review_history`、`ingestion_job`、`ingestion_step`、`index_release` 分开建模。
- 审核四态之外使用文件、任务/步骤、投影、Release、删除、Outbox/DLQ 和问答 Run 正交状态，不增加单一大状态枚举。
- Outbox 事件携带 `documentVersionId`、`projectionType`、`contentHash`、`schemaVersion`、`traceId`，不携带整篇正文。
- 文档级与 chunk 级 OpenSearch 索引使用同一 `document_version_id`、ACL、workspace 和有效期过滤。
- 发布状态、处理状态、索引可用状态和 alias 激活状态必须可解释、可重放、可回滚。
- 解析产物保留 Markdown、结构化 blocks、页码/slide/sheet/cell/bbox 和质量告警。

### P1/P2

- 只有多跳问题在黄金集上证明增益后，才引入 Neo4j/GraphRAG。
- 图谱实体消歧、关系冲突治理、图表深解析、讲者备注、音视频和跨文档推理后置。
- 图谱结果必须回到可授权、可定位的 chunk，不能直接作为无出处事实。

## 已同步的正式决策

- [ADR 0019：事件驱动索引投影](../adr/0019-event-driven-index-projections.md)
- [ADR 0020：文档审核状态机](../adr/0020-document-review-state-machine.md)
- [ADR 0021：多格式解析产物](../adr/0021-multi-format-parser-artifact.md)
- [ADR 0022：可选图谱证据通道](../adr/0022-optional-graph-evidence-channel.md)
- [ADR 0023：正交运行状态机](../adr/0023-orthogonal-runtime-state-machines.md)
