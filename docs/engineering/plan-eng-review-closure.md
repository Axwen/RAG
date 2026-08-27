# 企业级可信 RAG 基础 MVP：工程评审闭合记录

> 评审类型：`plan-eng-review`  
> 评审日期：2026-08-24  
> 评审对象：`docs/design/企业级可信RAG基础MVP-产品与架构边界.md`、`技术设计方案-TS企业级多模态RAG.md`及相关 ADR  
> 状态：`DONE_WITH_CONCERNS`  
> 结论：架构契约已闭合，可以进入架构探针和纵向实现；性能、解析质量和外部模型行为必须以实测结果更新，不得把候选目标当成现状或生产 SLO。

## 1. 评审范围与不在范围

本次评审检查的是从客服上传到可引用回复草稿的企业级基础 MVP 基座，包括领域边界、持久化事实、异步任务、索引发布、权限、引用、删除、恢复、测试和性能预算。

明确不在本次实现范围：

| 项目 | 处理方式 | 原因 |
|---|---|---|
| 研发、普通员工完整工作台 | 后置 | 共用基座和协议，阶段 1 只交付客服主链 |
| Git/Confluence/SharePoint/真实工单连接器 | 后置 | 当前没有上游系统，先用 JSON/CSV 合成或脱敏数据 |
| Neo4j、GraphRAG、RAPTOR、Agent | 后置 | 没有多跳黄金题收益证据，避免新增事实源和状态轴 |
| 音视频、跨语言、多模态向量 | 后置 | 不阻塞客服文档闭环 |
| 完整 ABAC 策略设计器和外部权限同步 | 后置 | 阶段 1 先完成 RBAC + 工作台成员 + 文档 ACL 的可审计决策 |
| 独立 Model Gateway、微服务拆分、插件市场 | 后置 | 单人项目先保持 NestJS 模块化单体和内部 Adapter |
| 生产 Kubernetes、多地域灾备、生产容量承诺 | 后置 | MVP 使用 Compose 和恢复演练验证协议 |
| MongoDB、独立向量数据库、Kafka/NATS | 后置 | PostgreSQL/OpenSearch/RabbitMQ 已足够覆盖阶段 1，减少第二事实源 |
| 完整运营报表和自动知识编译 | 后置 | 先交付反馈事件、指标和最小收件箱入口 |

## 2. 已存在的能力与复用边界

参考仓库只作为固定快照和行为参考，不作为本项目运行时依赖或测试替代品。

| 已存在能力 | 来源 | 本项目复用方式 | 不复用的边界 |
|---|---|---|---|
| 版面识别、OCR、表格还原、原文定位 | RAGFlow DeepDOC 固定快照 | 独立 Python Parser Service 产出 `ParseArtifact` | 不复制单文件，不接管 RAGFlow 数据库、任务表和业务权限 |
| 多路召回、候选预算、融合、Reranker、模型健康 | ragent 固定快照 | 作为检索和模型路由的实现参考，并以黄金集验证；只在测试 Harness 中做外部对照 | 不把其 RocketMQ、Spring 领域模型或整链检索插件边界带入阶段 1 运行时 |
| 前端 SSE、反馈、Trace 页面经验 | ragent 前端快照 | 参考交互和观测字段 | 不复制其权限、状态和接口契约 |
| PDF/消息队列/审核/图谱资料中的流程 | 当前 `pdf/` 材料 | 纳入 Outbox、审核四态、统一 ParseArtifact 和可选图谱证据原则 | 不照搬默认凭据、关闭安全的 Compose 或 MongoDB 双写 |

当前仓库没有业务实现代码、测试框架或可运行应用。因此“已存在”指参考材料和设计契约，不代表本项目已经通过测试。

## 3. 总体数据流

Worker 采用一个 `apps/worker` 代码库和两个独立运行 Profile：`ingestion` 负责解析、分块、Embedding、索引和发布任务，`evaluation` 负责黄金集与回归任务。两者共享消息契约和基础设施模块，但使用独立进程、队列绑定、并发与资源限制，避免评测负载挤占入库主链。

OpenSearch 的默认物理作用域固定为 `tenant_id + knowledge_space_id + index_partition_id`。`Workspace` 不写入索引事实，也不复制文档和 Chunk；API 在查询前解析工作台绑定的知识空间与授权策略，把由 PostgreSQL 编译出的 `acl_scope_key` 集合写入 BM25 与向量查询 `acl_scope_key IN allowedScopeKeys`；候选合并后再对候选集做一次批量 PostgreSQL 权威复核（文档级拒绝例外、墓碑、Legal Hold、有效期）。索引内不存储主体列表或 ACL 版本号。阶段 1 授权模型为纯作用域型；逐文档正向授权是加法、只能进预过滤，作为已识别扩展点预留但不实现（见 [ADR-0026](../adr/0026-acl-scope-key-and-authoritative-recheck.md)、[ADR-0036](../adr/0036-stage1-protocol-clarifications.md)）。

```text
                     ┌─────────────────────────────────────────┐
                     │           客服工作台 / Next.js           │
                     └───────────────┬─────────────────────────┘
                                     │ OIDC + API + SSE
                     ┌───────────────▼─────────────────────────┐
                     │ NestJS 模块化单体                         │
                     │ Auth / Document / Ingestion / Retrieval  │
                    │ Answer / Citation / Finalizer / Deletion │
                    │ Audit / Telemetry / Eval                 │
                     └───────┬──────────────────┬────────────────┘
                             │ PG transaction   │ query orchestration
              ┌──────────────▼─────────────┐    ▼
              │ PostgreSQL                 │  OpenSearch
              │ facts + outbox + audit     │  active aliases
              │ jobs + attempts + deletion │  BM25 + vector
              └──────────────┬─────────────┘
                             │ Outbox Relay + Publisher Confirm
                             ▼
              ┌──────────────────────────────────────────────┐
              │ RabbitMQ: tasks -> retry -> DLQ              │
              └────────────┬─────────────────┬─────────────────┘
                           │                 │
                           ▼                 ▼
                Node Worker / Indexer   Python Parser Service
                           │                 │
                           └────────┬────────┘
                                    ▼
                              MinIO / OSS Adapter

领域审计（状态迁移、授权、发布、删除）与业务事实在 PostgreSQL 同一事务中写入；Trace、Token、成本和高频遥测通过 Outbox 异步投递，不把安全审计依赖在观测系统可用性上。

Answer path:
  ACL prefilter -> BM25 || vector -> weighted fusion -> rerank Top5
  -> evidence gate -> risk-aware model call -> sentence verification
  -> persisted AnswerRun snapshot -> resumable SSE -> click-back citation
```

## 4. Manifest、Release 和作用域协议

### 4.1 作用域不变量

```text
Tenant
  └─ KnowledgeSpace
       ├─ IndexPartition(data_class, index_schema, embedding_version)
       │    └─ physical OpenSearch indexes + versioned aliases
       └─ shared DocumentVersions

Workspace ──binds──> one or more KnowledgeSpaces
Workspace does not create a physical index by itself.
```

- `Tenant` 是所有主键和查询的最高隔离域；即使阶段 1 只有一个租户，表、事件、索引文档和对象路径都必须带 `tenantId`。
- `KnowledgeSpace` 是索引和成员治理的默认物理作用域；工作台只是授权和策略组合，不为每个工作台复制索引。
- `IndexPartition` 的唯一键为 `(tenantId, knowledgeSpaceId, dataClass, indexSchemaVersion, embeddingVersion)`（见 [ADR-0028](../adr/0028-embedding-version-partition-and-rebuild.md)）。数据等级变化、索引 Schema 不兼容、Embedding 模型/维度/归一化/相似度度量变化都创建新分区，不原地重写旧分区。分块参数变化按 [ADR-0031](../adr/0031-chunking-frozen-after-probe.md) 与 Embedding 变化同等对待。
- 一个 `ReleaseManifest` 只属于一个 `KnowledgeSpace + IndexPartition`，只引用 `ingestionManifestId`；`PipelineManifest` 是兼容批准组合，不是 Release 的父对象；一个 `RetrievalSnapshot` 可以组合多个 Release。
- Alias 名称必须由租户、知识空间、分区和发布标识确定，禁止使用无作用域的全局线上 Alias。

### 4.2 Manifest 字段

所有 Manifest 都是内容寻址、不可变、可审计对象。建议 ID 使用 UUIDv7；数据库仍以主键约束和内容哈希防止重复。

| 对象 | 必填字段 | 不可变约束 |
|---|---|---|
| `IngestionManifest` | `id`, `tenantId`, `version`, `parserRef`, `chunkerRef`, `embeddingRef`, `indexSchemaRef`, `sourceFormats`, `contentHash`, `createdAt` | `APPROVED` 后不得修改；版本、向量维度、距离度量和 Chunk 规则变化必须新建 |
| `RetrievalManifest` | `id`, `tenantId`, `version`, `sparsePolicy`, `vectorPolicy`, `fusionPolicy`, `rerankerRef`, `candidateBudget`, `rerankInputSize`, `contentHash` | 召回通道、预算、融合、Reranker 变化必须新建 |
| `AnswerManifest` | `id`, `tenantId`, `version`, `promptRef`, `modelRouteRef`, `citationPolicy`, `riskPolicy`, `fallbackPolicy`, `contentHash` | Prompt、模型路由、引用或风险策略变化必须新建 |
| `PipelineManifest` | `id`, `tenantId`, `version`, `ingestionManifestId`, `retrievalManifestId`, `answerManifestId`, `compatibilityHash`, `approval`, `contentHash` | 只表达一个已批准兼容组合；不是 Release 的父对象，任何引用版本变化都新建 |
| `ReleaseManifest` | `id`, `tenantId`, `knowledgeSpaceId`, `indexPartitionId`, `ingestionManifestId`, `memberSetUri`, `memberSetHash`, `memberCount`, `docIndexName`, `chunkIndexName`, `candidateAlias`, `indexSchemaVersion`, `embeddingVersion`, `contentHash` | 不写回激活时间、当前 Alias 或最终替代关系 |
| `RetrievalSnapshot` | `id`, `tenantId`, `answerRunId`, `releaseRefs[]`, `retrievalManifestId`, `answerManifestId`, `approvedPipelineManifestIds[]`, `compatibilityHash`, `principalHash`, `scopeHash`, `aclRevision`, `candidateCountBeforeRecheck`, `candidateCountAfterRecheck`, `conflictResolution`, `evidenceSnapshotUri`, `evidenceSnapshotHash`, `createdAt` | 回答完成后不可修改；正文到期后只保留墓碑和指标 |
| `ReleaseActivation` | `id`, `releaseManifestId`, `knowledgeSpaceId`, `previousReleaseId`, `aliasBefore`, `aliasAfter`, `activatedAt`, `reconciledAt`, `result`, `traceId` | 唯一记录激活事实；不允许由 `ReleaseManifest.status` 代替 |
| `IndexActivationIntent` | `idempotencyKey`, `releaseManifestId`, `previousReleaseId`, `candidateAlias`, `requestedBy`, `outboxEventId`, `attemptCount`, `lastError`, `reconciliationState` | 只记录跨库操作意图和恢复信息，不是第二套激活事实源 |

> **2026-08-26 补充（PROBE-005 Stage C 实测触发）**：`RetrievalManifest` 新增必填字段 `rerankInputSize`，与 `candidateBudget` 分离。`candidateBudget` 是 OpenSearch 融合候选上限（ADR-0035 冻结为 1024），`rerankInputSize` 是实际送入 Reranker 的候选数；两者的差别是可测量的费用与时延差别（1024 候选 ¥0.1587 / 3.4-6.6 s，64 候选 ¥0.0099 / 0.95 s），因此它既是检索调优参数也是预算参数（见 [ADR-0017](../adr/0017-mvp-cloud-model-and-budget.md) 第 4、5 节与 [ADR-0029](../adr/0029-model-budget-ledger-and-limits.md)）。它必须进 Manifest 而不是留在环境变量里，否则 `RetrievalSnapshot` 无法复现一次问答的真实 rerank 输入规模，黄金集回归也无法归因「召回变化」与「N 变化」。默认值待用户拍板，实现侧先按 N=64。

### 4.3 兼容矩阵

| 组合 | 必须相等或满足 | 不满足时 |
|---|---|---|
| Ingestion -> Release | `parserRef`, `chunkerRef`, `embeddingRef`, `indexSchemaRef` 与物理索引字段一致 | Release 不能进入 `READY` |
| Embedding -> Vector Index | `dimension`、`metric`、归一化方式一致 | 拒绝构建，不允许运行时转换 |
| Retrieval -> Release | 每个向量通道的维度/字段存在；稀疏字段和过滤字段存在 | 候选构建失败 |
| Pipeline -> Release | Release 使用的 IngestionManifest 必须能通过已批准兼容组合；Pipeline 不是 Release 父对象 | 不能激活 |
| Retrieval + Answer -> Workspace | 策略版本属于工作台允许的 Policy Set，数据等级允许其模型执行区 | 请求 `BLOCKED` 或降级到允许路线 |
| Multi-space Snapshot | 每个 Release 通过自身 Ingestion 兼容检查；共同 Retrieval/Answer Manifest 和 `approvedPipelineManifestIds[]` 通过策略兼容检查 | 整个 Snapshot 拒绝，不部分回答 |

### 4.4 发布状态与恢复

```text
CREATED -> BUILDING -> VALIDATING -> READY
READY --activate--> ACTIVE
VALIDATING --fail--> FAILED
READY --abort--> ABORTED
ACTIVE --new release--> SUPERSEDED
ACTIVE --smoke failure--> ROLLING_BACK -> previous ACTIVE
```

`ReleaseActivation` 是唯一激活事实；`IndexActivationIntent` 驱动跨库恢复。Alias 已切换但 PostgreSQL 写回失败时，由 Reconciler 依据 Intent 完成确认或恢复旧 Alias。删除后的 Release 不得被回滚重新上线。

## 5. 正交状态机与并发规则

### 5.1 状态表

| 状态轴 | 状态 | 合法迁移和终态 |
|---|---|---|
| 文档审核 | `DRAFT`, `PENDING_REVIEW`, `PUBLISHED`, `ARCHIVED` | `DRAFT -> PENDING_REVIEW -> PUBLISHED -> ARCHIVED`；驳回 `PENDING_REVIEW -> DRAFT`；`ARCHIVED` 终态 |
| 文件资产 | `STAGED`, `VERIFYING`, `AVAILABLE`, `QUARANTINED`, `REJECTED`, `CORRUPTED` | `STAGED -> VERIFYING -> AVAILABLE/QUARANTINED/REJECTED`；完整性失败 `AVAILABLE -> CORRUPTED` |
| 入库 Job | `QUEUED`, `RUNNING`, `SUCCEEDED`, `PARTIALLY_SUCCEEDED`, `FAILED`, `CANCELED` | `QUEUED -> RUNNING -> terminal`；终态不可倒退 |
| Step | `PENDING`, `RUNNING`, `SUCCEEDED`, `FAILED`, `SKIPPED`, `CANCELED` | 仅由 Job 编排命令迁移；重试创建新 Attempt |
| Attempt | `CREATED`, `DISPATCHED`, `RUNNING`, `SUCCEEDED`, `FAILED`, `RETRY_SCHEDULED`, `CANCELED`, `STALE` | `RETRY_SCHEDULED` 和终态不可再次执行；旧 Generation 标为 `STALE` |
| 投影 | `PENDING`, `BUILDING`, `READY`, `FAILED`, `STALE`, `REMOVING`, `REMOVED` | `READY` 只表示投影完整，不表示线上可检索 |
| 删除请求 | `OPEN`, `PROCESSING`, `COMPLETED`, `PARTIAL_BLOCKED`, `CANCELED` | `COMPLETED` 仅在强制 Target 完成或合法 `HELD` 后进入 |
| 删除目标 | `PENDING`, `RUNNING`, `SUCCEEDED`, `HELD`, `FAILED`, `PROOF_MISSING` | `HELD` 需要 Legal Hold；`FAILED/PROOF_MISSING` 必须告警和重试 |
| Quick Parse | `UPLOADING`, `PARSING`, `READY`, `FAILED`, `EXPIRED`, `DELETING`, `DELETED` | 删除优先，`DELETED` 不得恢复正文 |
| AnswerRun | `QUEUED`, `RUNNING`, `COMPLETED`, `FAILED`, `CANCELED` | `phase` 和 `outcome` 独立保存 |
| Outbox | `PENDING`, `PUBLISHED`, `FAILED`, `EXHAUSTED` | 只能由 Relay 迁移；`EXHAUSTED` 进入运营告警 |
| Dead Letter | `OPEN`, `REPLAYING`, `RESOLVED`, `DISCARDED` | 重放必须创建新 Generation，原记录保留 |

问答使用正交字段：

```text
AnswerRun.status: QUEUED | RUNNING | COMPLETED | FAILED | CANCELED
AnswerRun.phase: AUTHORIZING | RETRIEVING | RERANKING | GENERATING | VERIFYING | FINALIZING
AnswerRun.outcome: ANSWERED | REFUSED | PARTIAL | EVIDENCE_ONLY | UNAVAILABLE
```

所有领域命令都使用 `version` 或 compare-and-set。重复命令必须返回已有结果，不能因为重试把状态向后覆盖。`searchable` 只由审核、资产、删除、有效期、必需投影、Active Release 和当前授权共同派生。

## 6. RabbitMQ 拓扑与消息协议

### 6.1 拓扑

```text
rag.tasks.topic (durable, topic)
  ├─ rag.ingestion.parse
  ├─ rag.ingestion.chunk
  ├─ rag.ingestion.embedding
  ├─ rag.projection.keyword
  ├─ rag.projection.vector
  ├─ rag.release.validate
  ├─ rag.resource.cleanup
  └─ rag.evaluation.run

rag.retry.topic (durable, topic)
  ├─ rag.retry.30s   --TTL 30s + DLX--> rag.tasks.topic
  ├─ rag.retry.5m    --TTL 5m  + DLX--> rag.tasks.topic
  └─ rag.retry.30m   --TTL 30m + DLX--> rag.tasks.topic

rag.tasks.dlx (durable, topic) -> per-type DLQ -> PostgreSQL dead_letter
```

本地单节点使用 durable classic queue；真实试点再评估三节点 quorum queue。每个队列单独配置 `prefetch`、并发、超时和租户配额。RabbitMQ 只负责传递和延迟，不是任务最终状态数据库。

### 6.2 消息最小契约

```ts
type TaskMessage = {
  messageId: string;
  eventId: string;
  eventType: string;
  schemaVersion: number;
  occurredAt: string;
  tenantId: string;
  traceId: string;
  jobId: string;
  stepId: string;
  attemptId: string;
  executionGeneration: number;
  idempotencyKey: string;
  deadline: string;
  documentVersionId?: string;
  indexReleaseId?: string;
  projectionType?: string;
  contentHash?: string;
  resourceVersionRefs: Record<string, string>;
}
```

消息不携带正文、Token、原始文件或可变配置。当前和上一 `schemaVersion` 可消费；未知版本进入隔离队列并写审计，不无限重试。

### 6.3 ACK、重试、取消和重放矩阵

| 场景 | PostgreSQL 动作 | Broker 动作 | ACK 行为 | 用户/运营可见结果 |
|---|---|---|---|---|
| 成功 | 幂等副作用提交，Attempt/Step 成功 | 无 | ACK | 任务成功 |
| 已完成幂等键 | 返回已有副作用引用 | 无 | ACK | 不重复建索引 |
| 旧 Generation | 记录 `STALE` 和原因 | 无 | ACK | 运营可见为过期执行 |
| 已取消 | 记录取消命中 | 无 | ACK | 用户看到已取消，不产生新副作用 |
| Deadline 过期 | Attempt 失败；按策略创建新 Attempt | 发布新的延迟消息 | 新消息 Confirm 后 ACK 原消息 | 可重试或最终失败 |
| 临时外部错误 | 当前 Attempt `RETRY_SCHEDULED`，创建新 Attempt + Outbox | 新 Attempt 进对应 retry queue | Confirm 成功后 ACK 原消息 | 任务保持可恢复 |
| 永久错误 | Attempt/Step 失败，创建 `dead_letter` | 进入 DLX | DLQ 持久化后 ACK 原消息 | 运营台可人工查看 |
| Broker 不可用 | PG 保留 Outbox，Attempt 不伪造成功 | 不发送 | 不 ACK，让连接恢复或由 Outbox 重发 | 不丢任务 |
| 人工重放 | 原 DLQ 保留；创建新 Generation、新 Attempt | 发布新消息 | 新消息 Confirm 后关闭重放动作 | 可追踪原失败与新执行 |
| 未知 Schema | 写协议错误和隔离记录 | 不 requeue | ACK 到隔离队列 | 需要升级 Worker/协议 |

重试所有者是应用任务编排，RabbitMQ TTL/DLX 只是调度延迟。任何“旧消息直接 requeue 无限循环”的路径都禁止进入实现。

## 7. Parser 长任务和 ParseArtifact

```text
Node Worker -> POST /internal/parser/tasks
           <- parserTaskId + accepted
Node Worker -> GET /internal/parser/tasks/:id (bounded poll)
           <- QUEUED/RUNNING/COMPLETED/FAILED/CANCELED
Parser     -> MinIO temp object
           -> checksum + schema validation
           -> atomic promote to artifact/{tenant}/{contentHash}/{parserVersion}
           -> COMPLETED + artifact URI/hash
```

- 幂等键为 `tenantId + contentHash + parserVersion`；相同输入返回已有 Artifact。
- 临时对象与正式 Artifact 使用不同前缀和生命周期；校验失败不得把临时对象标成可用。
- Worker 在每次副作用前检查 `executionGeneration`、取消状态和 Deadline。
- “完成但响应丢失”通过查询状态和内容哈希恢复，不重新生成第二份 Artifact。
- Parser 只写解析产物和质量告警，不改变审核、Release 或线上 Alias。

## 8. 数据分级、Retention、Legal Hold 与删除

以下是阶段 1 的默认试点策略，实际接入真实数据前必须由合规要求覆盖。TTL 是默认值，不是绕过 Legal Hold 的许可。

| 数据目标 | 默认等级 | 默认保留 | Legal Hold | 删除动作与证明 |
|---|---|---:|---|---|
| PG 业务记录/Manifest | 内部 | 业务记录 180 天；墓碑 7 年可配置 | 记录和审计保留 | 软删除后按 Target 执行，保存行数/哈希/时间证明 |
| PG 审计事件 | 审计 | 7 年可配置 | 不得清除 | 只允许合规归档，保存归档校验和 |
| MinIO 原文件 | 受控 | 文档归档后 180 天 | 暂停清理 | 删除对象版本并记录 Object Key、ETag、删除时间 |
| MinIO ParseArtifact/图片 | 受控 | 原文件删除后 30 天 | 暂停清理 | 删除对象及派生索引，记录 URI/哈希 |
| MinIO EvidenceSnapshot | 受控 | AnswerRun 完成后 90 天 | 暂停清理 | 删除候选/证据快照，保留哈希、墓碑和指标 |
| MinIO Evidence/ReplayBundle | 受控 | AnswerRun 完成后 90 天 | 暂停清理 | 删除受控重放对象，保留墓碑和指标 |
| MinIO AnswerRun 最终快照（正文 + 逐句引用 + 摘录） | 受控 | AnswerRun 完成后 90 天 | 暂停清理 | 唯一长期正文副本，删除后只保留墓碑、哈希和指标 |
| PG `answer_run_event`/`answer_sentence`/`citation` | 内部 | 与 PG 业务记录一致（180 天） | 记录保留 | 只含元数据与载荷哈希，无正文可删；删除只写墓碑 |
| Redis SSE 续读窗 `run:{runId}:events` | 受控 | 24 小时 | 不作为长期证据 | 按 Key 前缀删除并记录数量；过期后续读回落最终快照 |
| OpenSearch 文档/Chunk | 受控 | 对应文档删除后 24 小时内 | 暂停物理清理，但查询必须 fail closed | 记录 index、doc/chunk 数和刷新确认 |
| Redis 缓存/会话 | 内部 | 24 小时或业务 TTL | 不作为长期证据 | 按 Key 前缀删除并记录数量 |
| Quick Parse 内容 | 受控 | 空闲 24 小时，硬上限 72 小时 | 只有显式合规 Hold 才暂停 | 立即删除原文/Artifact，状态降级为 Metadata/墓碑 |
| RabbitMQ 活跃/重试消息 | 内部 | 处理完成后 7 天 | 不恢复正文 | ACK/过期清理，保存事件 ID 和最终状态 |
| RabbitMQ DLQ | 审计 | 30 天 | 按事件关联 | 解决/丢弃前保留原消息哈希和处置人 |
| Trace/日志 | 内部/受控 | Trace 30 天，日志 14 天 | 按合规策略 | 脱敏后按 Trace/对象删除，保存删除证明 |
| 备份 | 受控 | 30 天滚动 | Hold 版本不得覆盖 | 到期轮换；删除请求记录受备份窗口影响 |
| 云模型供应商请求/响应 | 受控 | 供应商承诺为准，默认不允许持久化 | 不得用业务 Hold 扩大外发 | 只发合成/严格脱敏数据，保存供应商策略快照 |

### 8.1 删除状态机

```text
deletion_request: OPEN -> PROCESSING -> COMPLETED
                              ├──────-> PARTIAL_BLOCKED (Legal Hold / failed target)
                              └──────-> CANCELED (only before purge starts)

deletion_target: PENDING -> RUNNING -> SUCCEEDED
                              ├──────-> HELD
                              └──────-> FAILED -> PROOF_MISSING -> retry
```

删除请求创建时立即使文档、Chunk、证据和引用预览 `fail closed`；物理副本清理是异步过程。所有强制 Target `SUCCEEDED` 或合法 `HELD` 后才能关闭请求。已删除资源不能通过旧 Release、旧 RetrievalSnapshot、备份恢复或 DLQ 重放重新出现在检索中。Alias 激活、回滚、索引重建和人工重放都必须重新校验删除墓碑、Legal Hold、`acl_scope_key` 与文档级拒绝例外和有效期；包含 `SOFT_DELETED`、`PURGING` 或 `PURGED` 目标的 Release 不得激活，历史 Release 不原地改写，只能构建过滤后的新 Release。回答正文的删除目标包括 AnswerRun 快照、EvidenceSnapshot 和 Redis 前缀；PostgreSQL 侧无正文需要清理，只保留元数据、哈希和墓碑（见 [ADR-0030](../adr/0030-answer-body-storage-tiers.md)、[ADR-0036](../adr/0036-stage1-protocol-clarifications.md)）。

### 8.2 Replay 等级

```text
FULL           = 原文/ParseArtifact/证据/回答快照仍在保留期内，可按快照重放
METADATA_ONLY  = 只保留哈希、版本、ID、指标和墓碑，不恢复正文
EXPIRED        = TTL/合规删除完成，不可重放
```

默认 Quick Parse：FULL 直到内容清理；清理后 METADATA_ONLY 30 天；其后 EXPIRED。quick_parse 可以产生 `TEMPORARY` 会话级引用，但不进入正式 Release；业务资料删除优先于黄金集可复现性，黄金题必须更新证据引用或标为不可运行。

## 9. SSE、风险分级和引用协议

### 9.1 事件格式

```ts
type AnswerEvent = {
  runId: string;
  seq: number;
  eventId: string;
  schemaVersion: 1;
  event: "run.accepted" | "phase.started" | "retrieval.completed" |
    "evidence.delta" | "answer.delta" | "citation.updated" | "warning" |
    "run.completed" | "run.failed" | "run.canceled";
  occurredAt: string;
  payload: Record<string, unknown>;
};
```

`runId + seq` 在 PostgreSQL 中唯一。PostgreSQL 只持久化事件元数据与载荷哈希，正文与摘录增量写入 Redis 续读窗 `run:{runId}:events`（TTL 24 小时），长期正文只存在于对象存储快照（见 [ADR-0030](../adr/0030-answer-body-storage-tiers.md)）；heartbeat 不进入事实表。客户端用 `Last-Event-ID` 或 `lastEventSeq` 续读：Redis 命中则从该序号继续推送，Redis 已过期或丢失则不拼接正文，直接返回最终快照并由界面整体渲染，同时给出明确提示。序号与快照都已过 Retention 时只返回墓碑信息。

### 9.2 普通/高风险回答

```text
普通：retrieve -> generate draft -> verify sentence/citation -> final snapshot
       answer.delta 可以发送，但 UI 必须标为草稿，未验证句不能标为事实
       验证 = 句切分 + token 重叠 + 逐句批量向量，P95 <= 2.0 s

高风险：retrieve -> rerank -> evidence gate -> generate -> verify -> answer.delta
        验证前只发送 phase/evidence/warning；失败返回 REFUSED/EVIDENCE_ONLY
        验证 = 常规路径 + 一次蕴含调用，P95 <= 3.5 s
        逐句批量向量与蕴含调用必须并发发起（串行实测下界约 4.3 s）
```

> 两条验证预算于 2026-08-26 随 [ADR-0027](../adr/0027-tiered-citation-verification-budget.md) 的 PROBE-005 实测修订更新（原 600 ms / 1.5 s）。

引用状态使用 `PENDING / VERIFIED / WEAK / CONFLICT / BLOCKED / EXPIRED`；`WEAK` 必须在界面显式标注，`CONFLICT` 按 [ADR-0033](../adr/0033-deterministic-evidence-conflict-resolution.md) 同时展示两条来源且不给出单一结论，`AnswerFinalizer` 不得将含未解决冲突的运行提交为 `ANSWERED`，只能提交 `PARTIAL`、`EVIDENCE_ONLY` 或 `REFUSED`。引用点击、预览和下载都重新执行当前 ACL，而不是信任历史快照授权。模型原始思考链不存储，只记录阶段、证据摘要、工具结果、版本、错误码和 Trace。

## 10. quick_parse 默认协议

| 项目 | 默认规则 |
|---|---|
| 会话 TTL | 空闲 24 小时；硬上限 72 小时 |
| Parser | 复用主 ParserAdapter 和 ParseArtifact，不进入长期 Release |
| Embedding | 查询需要时按批生成；不默认完整长期向量化 |
| Index | 使用带 session scope 的临时索引或受控内存候选，不与生产 Alias 混用；临时引用标记 `TEMPORARY` |
| Replay | FULL -> METADATA_ONLY -> EXPIRED |
| 主动删除 | 用户删除或租户删除命令立即触发 `DELETING`，优先于 TTL |
| 外发 | 继承文档和查询最高数据等级，`UNKNOWN`/敏感默认阻断云模型 |
| 注入检查 | 与正式内容相同的三处检测；命中只作证据展示或直接阻断 |
| 过期 UX | 返回“临时资料已过期”，不静默复用旧证据 |

## 11. 九个交付增量与 DoD

第 2 至第 6 项是客服纵向主链；第 1、7 至第 9 项是横切闭环。每项都必须包含状态、权限、审计、失败路径、自动测试、演示和恢复方式。

| 增量 | 用户可见结果 | 独立 DoD | 失败注入和恢复 |
|---|---|---|---|
| 1. 身份与授权 | 用户能登录、进入工作台并看到有权知识 | Keycloak OIDC；业务用户/成员/ACL；跨租户、跨工作台、越密级为 0；授权决策可审计；撤权后新查询 fail closed | token 过期、Keycloak 不可用、ACL revision 竞态；恢复后不扩大权限 |
| 2. 上传与资产 | 上传后得到不可变文档版本和安全状态 | `upload_session` 临时前缀；presign/complete 幂等；hash/MIME/大小/恶意文件检查；正式对象复制并经 `object_claim` 与 PG 关联；重复上传复用或明确新版本；不可变版本可查看；未认领对象可按 TTL 清扫并有证明 | 断点上传、恶意文件、临时对象过期、正式对象复制成功但 PG 失败、响应丢失；Cleanup Worker 和补偿流程必须可恢复 |
| 3. Parser Artifact | 支持首批格式并能回跳页码/块位置 | Markdown、原生/扫描 PDF、JSON/CSV 通过门禁；ParseArtifact schema、定位、质量告警；Office 仅探针不阻断首批 | Parser 崩溃、OCR 超时、响应丢失、低质量表格；状态可重试且不生成半成品 |
| 4. 异步投影与 Release | 文档可构建候选索引并安全发布 | Outbox/RabbitMQ；任务、Attempt、Generation、取消、DLQ、重放；BM25/向量候选；Release 校验、Alias 激活、对账和回滚 | 重复消息、旧 Generation、Alias 切换窗口、OpenSearch 不可用；故障注入后可恢复 |
| 5. ACL 混合检索 | 客服得到可解释的 Top5 证据 | ACL 前置；BM25 + 1024 维向量并行；融合候选预算 1024；Rerank Top5；固定 RetrievalSnapshot；冲突按权威级别和适用范围处理 | ACL 变更竞态、空召回、OpenSearch 超时、跨空间冲突；拒答或 evidence-only |
| 6. AnswerRun 与 SSE | 客服得到带引用的可复制回复草稿 | 普通/高风险策略；句级引用验证；无据句处理；断线续读；停止/重试/降级；不泄露 CoT | 模型超时、流断开、引用验证失败、重复事件；最终快照可恢复 |
| 7. Replay 与影响分析 | 临时资料过期和知识变更可解释 | Quick Parse TTL；FULL/METADATA_ONLY/EXPIRED；删除墓碑；最小影响分析入口列出受影响 Release/黄金题/AnswerRun | TTL 竞态、删除后重放、历史证据缺失；fail closed 并返回墓碑 |
| 8. 反馈与评测 | 能知道客服是否采纳答案，发布有质量证据 | 采纳/修改/升级/引用点击/纠错/无据/拒答反馈事件；50 道黄金题可重复；门禁报告和成本统计 | 反馈重复/丢失、模型输出漂移、题目证据被删；事件幂等，题目版本化 |
| 9. 删除、恢复与演练 | 管理员能删除、证明删除并恢复服务 | deletion_request/target；Legal Hold；PG/OS/MinIO/Redis/Rabbit/Trace/Backup 矩阵；删除证明；上一 Release 回滚；恢复演练记录 | 部分 Target 失败、备份含旧数据、DLQ 重放旧版本；请求保持阻断并告警 |

## 12. 测试覆盖图

```text
CODE PATHS                                      USER FLOWS
[1] Auth/ACL                                    [U1] 登录 -> 选择工作台 -> 查询
  ├─ token valid / expired                       ├─ [E2E] 越权空间不可见
  ├─ member allowed / denied                    ├─ [E2E] 撤权后引用预览拒绝
  └─ scope prefilter + candidate recheck         └─ [GAP until impl] Keycloak outage UX

[2] Upload/Asset                                 [U2] 上传 -> 安全检查 -> 版本详情
  ├─ duplicate hash                              ├─ [E2E] 断点/重复 complete 幂等
  ├─ malware/quarantine                          └─ [E2E] 对象写成 PG 失败可补偿
  └─ object/PG partial failure

[3] Parser/Artifact                              [U3] PDF/Markdown/JSON -> 可定位证据
  ├─ normal / OCR / table warning                ├─ [E2E] 页码/bbox 回跳
  ├─ timeout / crash / cancel                    ├─ [E2E] 响应丢失后查询恢复
  └─ incomplete temp object -> reject            └─ [EVAL] 解析质量黄金样本

[4] Queue/Release                                [U4] 候选发布 -> Alias -> 回滚
  ├─ confirm / duplicate / stale generation      ├─ [E2E] Alias 已切 PG 未写回
  ├─ retry / DLQ / replay                         ├─ [E2E] DLQ 人工重放新 Generation
  └─ validation / smoke failure                  └─ [E2E] smoke 失败恢复上一 Release

[5] Retrieval                                    [U5] 询问 -> 召回 -> Top5 证据
  ├─ sparse/vector empty or timeout               ├─ [EVAL] Recall@5/权威冲突
  ├─ fusion budget / rerank error                 ├─ [E2E] 多空间确定性合并
  └─ stale ACL / expired evidence                 └─ [E2E] 无据问题拒答

[6] Answer/SSE/Citation                           [U6] 流式回答 -> 引用点击 -> 复制草稿
  ├─ ordinary answer delta                         ├─ [E2E] Last-Event-ID 续读
  ├─ high-risk buffered until verify              ├─ [E2E] 高风险验证失败不泄露正文
  ├─ weak/conflict/blocked citation               └─ [EVAL] 覆盖率、正确率、忠实度、拒答
  └─ model timeout / cancel / fallback

[7-9] Replay/Feedback/Delete/Recovery            [U7] 删除 -> 墓碑 -> 影响分析
  ├─ FULL -> METADATA_ONLY -> EXPIRED             ├─ [E2E] 删除后旧 Snapshot 不可恢复正文
  ├─ target succeeded/held/failed                 ├─ [E2E] Legal Hold 阻断并可解除
  └─ backup/DLQ/release recovery                  └─ [E2E] 恢复演练后权限和删除事实仍生效

[X] Cross-cutting protocol gates                   [U8] 故障时仍给出可解释结果
  ├─ ingestion/evaluation profile isolation        ├─ [INT] evaluation 不挤占 ingestion
  ├─ Keycloak outage / session expiry               ├─ [E2E] 登录失败可重试且不放宽权限
  ├─ temp object promote/claim/cleanup              ├─ [INT] 孤儿对象可清扫并有证明
  ├─ deletion before activation/replay              ├─ [E2E] 删除中 Release 不可激活/回滚
  ├─ finalizer rejects unverified body              ├─ [E2E] 未验证正文不能成为最终结果
  ├─ injection none/suspected/blocked               ├─ [E2E] 注入内容不进生成上下文
  ├─ per-user quota / budget ledger lease           ├─ [INT] 429 与预算熔断不降级验证
  └─ audit sync vs telemetry async                 └─ [INT] 遥测不可用不影响领域提交

覆盖目标：每个状态迁移和错误分支有领域/契约测试；跨 3 个以上组件的链路用真实容器 E2E；Prompt、模型路由、引用规则变更必须跑固定版本 RAG EVAL。测试基线为 Vitest、Supertest、Testcontainers、Playwright，Python Parser 使用 pytest；CI 真实启动 core 中间件并按测试组复用容器。P1 协议测试还必须覆盖 Worker Profile 隔离、Keycloak 生命周期、对象认领/清扫、删除优先级、Answer/Citation/Finalizer 和审计/遥测隔离。
```

## 13. Failure Modes Registry

| ID | 生产失败模式 | 测试 | 错误处理 | 用户结果 | 级别 |
|---|---|---|---|---|---|
| F-01 | Outbox 写入成功但 Relay 崩溃 | 集成/故障注入 | Relay 扫描 PENDING 重发 | 延迟，不丢任务 | P1 |
| F-02 | Publisher Confirm 丢失导致重复投递 | 幂等测试 | message/idempotency key 去重 | 不重复索引 | P1 |
| F-03 | 旧 Generation 迟到执行副作用 | 并发测试 | 执行前 CAS 校验，标 STALE | 不改变线上结果 | P1 |
| F-04 | 重试无限循环 | retry/DLQ 测试 | 应用 Attempt 上限 + DLQ | 任务失败可人工处理 | P1 |
| F-05 | Parser 产出半个 Artifact | 对象故障注入 | 临时前缀 + 校验 + 原子 promote | 文档不可发布，显示解析失败 | P1 |
| F-06 | Parser 完成但响应丢失 | 契约/恢复测试 | parserTaskId 查询 + contentHash 幂等 | 可恢复，不重复解析 | P1 |
| F-07 | Alias 已切但 PG 未确认 | 发布故障注入 | Intent + Reconciler | 短时不可发布或自动回滚 | P1 |
| F-08 | ACL 在召回期间撤权 | 安全并发测试 | 候选集在 PostgreSQL 做权威复核，fail closed | 不展示过期证据 | P0 |
| F-09 | 多空间同一事实冲突 | RAG EVAL | 权威级别/版本/地域确定性规则 | 显示冲突或拒答 | P1 |
| F-10 | 模型流断开或超时 | E2E | 最终快照、重试、降级 | 可恢复或明确失败 | P1 |
| F-11 | 高风险验证失败但正文已流出 | 安全 E2E | 高风险生成前缓冲 | 只显示证据/拒答 | P0 |
| F-12 | 删除只清 PG，OS/MinIO 留副本 | 删除集成测试 | Target 逐项证明，未完成保持阻断 | 删除中不可检索 | P0 |
| F-13 | 旧 DLQ 重放重新出现已删除数据 | 删除+重放测试 | Generation/删除墓碑优先校验 | 不恢复正文 | P0 |
| F-14 | Quick Parse TTL 竞态导致过期证据继续使用 | TTL 并发测试 | 查询前状态和对象存在性校验 | 显示已过期 | P1 |
| F-15 | 云模型收到 UNKNOWN/敏感数据 | 外发策略测试 | 数据等级门禁，默认阻断 | 明确不可用，不外发 | P0 |
| F-16 | 反馈事件重复或丢失 | 幂等/集成测试 | feedback event key + Outbox | 指标可解释 | P2 |
| F-17 | evaluation 评测负载挤占 ingestion 资源 | Worker 隔离/配额测试 | 独立进程、队列绑定、并发和预算池 | 入库延迟可解释，不被评测拖垮 | P1 |
| F-18 | Keycloak 不可用或会话撤权传播延迟 | OIDC 故障/E2E | 过期会话 fail closed，恢复后重新校验 | 明确登录/授权不可用，不展示证据 | P0 |
| F-19 | 临时对象过期、promote 成功但 PG 失败形成孤儿 | 对象生命周期/补偿集成测试 | object_claim + TTL 清扫 + 删除证明 | 不产生可检索资产，管理员可追踪 | P1 |
| F-20 | 删除中的 Release 被激活、回滚或 DLQ 重放 | 删除优先级并发测试 | 墓碑/Legal Hold/作用域与文档级 ACL 前置校验 | 旧正文不可复活，操作返回阻断原因 | P0 |
| F-21 | 未验证回答正文被错误提交为最终快照 | AnswerFinalizer 契约/E2E | 只接受 VERIFIED/允许的 PARTIAL 结果 | 用户看到证据、拒答或不确定，而非伪事实 | P0 |
| F-22 | 领域审计依赖遥测系统导致状态提交失败或无审计 | 事务/故障注入测试 | 审计同步入 PG，Trace/成本异步 Outbox | 业务状态可用且审计不丢，遥测延迟可见 | P1 |
| F-23 | OpenSearch fan-out、候选数组或模型缓冲无界导致内存/延迟尖峰 | 资源压测/超时降级测试 | fan-out <= 2、候选 <= 1024、超时和降级硬上限 | 返回部分证据/不可用，不拖垮 Worker | P1 |
| F-24 | 模型调用超出单次/每日/月度预算 | 预算熔断集成测试 | 预扣预算、按 profile 预算池、超限停止评测/降级 | 明确预算耗尽，不静默失败或继续扣费 | P1 |
| F-25 | 权限收紧后旧 Release 仍按快照内的 ACL 返回证据 | 授权传播集成测试 | 索引只带作用域键；候选合并后做 PG 权威复核 | 撤权立即生效，无需重建索引 | P0 |
| F-26 | 预扣成功但进程崩溃，额度永久占用 | Lease 回收故障注入测试 | `model_budget_ledger` lease 过期回收 | 额度自动释放，占用可解释 | P1 |
| F-27 | 文档内注入指令改变系统行为或诱导外发 | 注入样本集安全测试 | 定界符 + 三处检测 + `EVIDENCE_ONLY`/`REFUSED` | 不越权、不外链、不执行文档内指令 | P0 |
| F-28 | 同一输入因空间遍历顺序不同得到不同回答 | 确定性重复运行测试 | 全序排序键 + `CONFLICT` 显式判定 | 结果可复现；冲突被展示而非静默择一 | P1 |
| F-29 | 单用户高频提问耗尽交互预算池 | 用户级限流测试 | Redis 并发/QPS/日限 + PG 硬预算闸门 | 返回 `429`，其他用户不受影响 | P1 |
| F-30 | 云模型供应商限流（429）被当作契约裁决或排序结果 | ModelAdapter 限流/降级测试 | Adapter 统一退避重试（供应商不返回 `retry-after`）+ 截断候选降级；限流不进入排序或契约判定路径 | 回答延迟可解释，不把节流误报为供应商能力缺陷或错误排序 | P1 |

P0 失败模式没有测试、没有错误处理或对用户静默时禁止进入发布门禁。

## 14. 性能与资源预算

以下是实现阶段的预算和测量点，不是已经达到的成绩。

| 路径 | 预算/目标 | 测量方法 |
|---|---:|---|
| presign/complete API（不含上传传输） | P95 <= 300 ms | NestJS HTTP + PG/MinIO 集成压测 |
| 作用域预过滤 + Snapshot 创建 | P95 <= 80 ms | PG query trace |
| BM25 与向量并行召回 | P95 <= 250 ms | OpenSearch 真实容器，候选上限 1024 |
| ACL 候选权威复核 | P95 <= 60 ms（不计入上一行 250 ms） | 单条批量 PG 查询，禁止逐候选查询 |
| 本地融合（不含云 rerank） | P95 <= 100 ms | 记录每路候选数与融合耗时；纯本地计算，不含任何供应商往返 |
| 云 Rerank → Top5（独立计时，不与融合合并） | P95 <= 1.2 s @ N=64；N 变更时按实测重设 | 云 rerank 单独计时。**PROBE-005 Stage C 实测：64 候选 0.95 s、256 候选 1.45 s、1024 候选 3.4-6.6 s** —— 原「融合 + Rerank Top5 P95 <= 350 ms」在云 rerank 下任何档位都不可达，已按实测拆成本行与上一行 |
| 首 token | P50 作为候选目标，首轮实测后重估 | 模型 Adapter 记录 TTFT，不与完整回答混淆 |
| 引用验证（常规路径） | P95 <= 2.0 s | 句切分 + token 重叠 + 逐句批量向量，分项计时 |
| 引用验证（高风险路径） | P95 <= 3.5 s | 常规路径 + 一次蕴含调用（两者必须并发发起），分项计时 |
| 完整回答 | 不设单一 SLO；拆分检索、TTFT、生成、验证 | AnswerRun span 汇总 |
| 端到端候选目标 | P50 1.2 s 仅在固定黄金集和固定模型上报告；不作为单一硬 SLO | CI 报告检索、TTFT、生成、验证分项基线差异 |

本地 32 GiB 主机固定 WSL2 日常上限 22 GiB；DeepDOC 或批量评测只能显式切换到 24 GiB profile，不与日常 profile 并行。初始资源硬上限如下：

| Profile/组件 | 并发与内存上限 | 队列/费用规则 | 超限行为 |
|---|---|---|---|
| `worker:ingestion` | Node 并发 4；最大 in-flight 8 | parse `prefetch=1`；投影 `prefetch=4` | 新任务排队，不继续提高并发 |
| `worker:evaluation` | 独立进程并发 1；最大 in-flight 1 | 独立 evaluation 队列和预算池；不消费 ingestion 队列 | 评测暂停或排队，不能抢占入库 |
| DeepDOC Parser | 并发 1；单进程 RSS 警戒 8 GiB | 解析超时进入 Attempt 重试/DLQ | 超过警戒先取消/隔离，不启动第二实例 |
| OpenSearch | JVM 初始 2 GiB；单请求候选 <= 1024；堆外向量内存单列记录 | fan-out <= 2 个 KnowledgeSpace；请求总超时 250 ms；kNN engine/参数由 PROBE-003 冻结 | 先降级超时通道，双通道失败返回 evidence unavailable |
| 云 Reranker（独立计时/计费，**不计入上行 250 ms**） | 输入候选数 = `RetrievalManifest.rerankInputSize`，与 `candidateBudget`(1024) 分离；实现侧待拍板前按 N=64 | 实测 8/64/256/1024 候选 → 0.89/0.95/1.45/3.4-6.6 s、¥0.0012/0.0099/0.0397/0.1587；超时按上界而非均值设定；供应商 2048 候选仍返 200，上限保护必须在 Adapter 侧 | 退避重试 429（不带 `retry-after`）→ 截断候选降级 → 仅在仍不可用时跳过 rerank；回显正文禁入日志（`return_documents=false` 不生效） |
| Answer/Citation | 高风险生成缓冲上限 2,048 output tokens；常规验证超时 2.0 s、高风险 3.5 s | 未验证正文不得提交 Finalizer | 返回 `EVIDENCE_ONLY`/`REFUSED`，释放缓冲 |
| ModelAdapter | 单次预算 <= 5 元；每日 <= 16 元；月度 <= 500 元（16 × 31 = 496，三个上限自洽） | 交互池 350 元、评测池 100 元、应急保留 50 元；调用前在 PG `model_budget_ledger` 内预扣并取 lease；单次口径 = Chat + 查询 Embedding + **Reranker** + 逐句验证 Embedding + 蕴含调用；结算优先写回供应商返回的 `usage.cost` | 预算不足停止评测，交互请求走允许的降级/拒答 |
| 用户级配额 | 并发 AnswerRun 1；并发 SSE 2；提问 10 次/分钟、200 次/日；上传 20 个/小时 | 频次计数由 Redis 软闸门承担；AnswerRun/SSE 由本地 semaphore + PostgreSQL 用户并发 lease 兜底；默认值待 PROBE-005 与首轮评测校准 | 返回 `429` 与 `Retry-After`，不降级验证或缩短候选集 |

所有上限都必须作为配置 schema 校验并写入启动日志。动态调节只允许在硬上限内根据 RSS、队列等待、GC、OpenSearch heap 和模型费用进行降级，不允许运行时自动突破上限。

性能实现规则：批量读取 Workspace 绑定、ACL 和 Manifest，禁止按 Chunk/候选逐条访问 PostgreSQL；Redis 只缓存不可变 Manifest、Workspace 绑定和带 `aclRevision` 的"主体 → 允许作用域集合"，不缓存最终授权结论、复核结果或正文；OpenSearch 查询必须把租户、知识空间、分区、版本、删除墓碑和 `acl_scope_key` 过滤编译进请求，索引内不落 `acl_subject_ids` 与 `acl_revision`（见 [ADR-0026](../adr/0026-acl-scope-key-and-authoritative-recheck.md)）。

## 15. 六个架构探针的验收

| 探针 | 输入 | 必须测量 | 通过条件 |
|---|---|---|---|
| Keycloak/OIDC | Realm 配置、管理员用户、普通用户、工作台成员、过期/撤权场景 | Realm 可重复导入、Code + PKCE、Token/JWKS 校验、用户映射、会话过期、撤权传播、不可用恢复 | 本地启动和登录可重复；身份与业务授权边界明确；过期、撤权和故障时 fail closed |
| DeepDOC | 扫描 PDF、双栏、跨页表格、普通 Markdown | 启动、RSS、解析耗时、定位质量、表格告警、Artifact 原子提交 | 产出契约稳定；失败和取消可恢复；资源不超过本地预算 |
| OpenSearch | 文档/Chunk 双索引、1024 向量、kNN engine/参数候选、Alias | 写入耗时、查询 P50/P95、带过滤 kNN 召回衰减、heap 与堆外内存峰值、Alias 切换、对账、重启恢复 | 版本化 Alias 和回滚可验证；作用域键/版本过滤不丢失；kNN 参数可冻结且内存在预算内 |
| RabbitMQ | 成功、重复、超时、取消、DLQ、人工重放 | Confirm、ACK、retry delay、prefetch、队列积压、重复率 | 不丢消息、不无限 requeue；重放生成新 Generation |
| 云模型 ModelAdapter（供应商基线见 ADR-0017） | Chat/Embedding/Reranker/引用验证、流式取消、错误码、预算账本 | TTFT、逐句批量 Embedding、蕴含验证、费用、限流、超时、数据分级门禁、预扣/结算/lease 回收 | OpenAI-compatible 契约稳定；四类调用的错误映射与预算阻断可验证；分层验证预算实测可达 |
| 分块与引用定位 | PROBE-002 解析产物、黄金集子集、候选分块参数组合 | Recall@5、引用可定位率、表格/条款截断率、索引体积、写入耗时、结果可复现性 | 存在一组可冻结参数同时满足 Recall@5 与引用可定位率；Chunk 序列确定性可复现 |

探针失败时只允许调整 Adapter、资源配置或首批格式，不得绕过 PostgreSQL、Outbox、权限、引用和删除门禁。

## 16. 实施任务

以下任务都来自本评审发现，不代表已经开始实现。探针收尾后的当前任务范围、补充 Tickets 和依赖顺序以 [阶段 1 实施 Tickets](stage1-implementation-tickets.md) 为准；每张任务还必须按 [Probe Decision Gate](probe-decision-gate.md) 关闭对应的增量条件。

- [ ] **T1a (P1, human: ~3d / CC: ~0.75d)** — Manifest/Prisma Core — 建立租户、知识空间、文档版本、基础 Manifest、Release 和兼容矩阵。
  - 来源：Architecture Review，版本任意组合和 Release 作用域会导致不可测试的状态空间。
  - 计划文件：`packages/database/prisma/schema.prisma`、`packages/contracts/src/manifests/`、`apps/api/src/modules/release/`。
  - 范围补充：`PipelineManifest` 是兼容批准组合，不是 Release 的父对象；`ReleaseManifest` 只引用 `ingestionManifestId`，`RetrievalSnapshot` 记录共同 Retrieval/Answer 策略和兼容校验（ADR-0036）。
  - 验证：Prisma 迁移测试、内容哈希/唯一约束测试、兼容/不兼容表驱动测试。
- [ ] **T1b (P1, human: ~2d / CC: ~0.5d)** — Chunk/Index Schema — 建立 `chunk_manifest`、`wide-1024` Chunk 定位和最终 OpenSearch mapping。
  - 来源：PROBE-006 已冻结 `parent_child=false`；阶段 1 不建立父子分块字段或父子展开路径。
  - 计划文件：`packages/database/prisma/schema.prisma`、`packages/contracts/src/chunking/`、`apps/api/src/modules/search/`。
  - 依赖：PROBE-006 必须为 `PASS` 或 `PASS_WITH_ADJUSTMENT`；`BLOCKED` 时只允许保留契约草稿，不进入正式索引实现。
  - 验证：确定性 Chunk 序列、页/坐标/section 定位和 mapping 兼容测试，并断言阶段 1 mapping 不出现父子关系字段。
- [ ] **T2 (P1, human: ~6d / CC: ~1.5d)** — Domain State — 实现正交状态命令、CAS 和可检索派生规则。
  - 来源：Architecture Review，审核、资产、任务、投影、删除和 AnswerRun 不能折叠成单一状态。
  - 计划文件：`packages/contracts/src/states/`、`apps/api/src/modules/document/`、`apps/api/src/modules/ingestion/`、`apps/api/src/modules/deletion/`。
  - 验证：Vitest 表驱动覆盖所有合法/非法迁移、终态、并发版本冲突和 `searchable` 派生。
- [ ] **T3 (P1, human: ~6d / CC: ~1.5d)** — MessageBus — 建立 Outbox、RabbitMQ Attempt/Generation、Retry/DLQ/Replay 协议。
  - 来源：Architecture Review，PostgreSQL 与 RabbitMQ 的双重重试所有权会导致重复、复活和无限重试。
  - 计划文件：`packages/contracts/src/events/`、`apps/api/src/modules/outbox/`、`apps/worker/src/message-bus/`。
  - 验证：Testcontainers 故障注入 Publisher Confirm 丢失、Broker 中断、迟到消息、取消和人工重放。
- [ ] **T4 (P1, human: ~6d / CC: ~1.5d)** — Parser/ObjectStorage — 实现异步 Parser 任务和两阶段对象认领协议。
  - 来源：Architecture/Code Quality Review，同步 Parser 接口和“对象存在即提交”无法恢复长任务及跨库部分失败。
  - 计划文件：`services/parser/`、`packages/contracts/src/parser/`、`apps/api/src/modules/object-storage/`、`apps/worker/src/profiles/ingestion/`。
  - 验证：pytest 契约测试与容器集成测试覆盖 OCR、取消、响应丢失、promote 后 PG 失败和孤儿清扫。
- [ ] **T5 (P1, human: ~5d / CC: ~1d)** — Release/OpenSearch — 实现候选构建、Alias 激活 Intent 和 Reconciler。
  - 来源：Architecture Review，OpenSearch Alias 与 PostgreSQL 激活事实存在分裂窗口。
  - 计划文件：`apps/api/src/modules/release/`、`apps/worker/src/profiles/ingestion/release/`、`apps/api/src/modules/search/`。
  - 范围补充：包含从不可变 `ParseArtifact` 与 `chunk_manifest` 出发的知识空间重建（`POST /api/v1/knowledge-spaces/:spaceId/rebuild`），新 `embeddingVersion` 进新分区、旧分区保留用于回滚、重建受预算门禁与每租户并发 1 约束（ADR-0028）；正式索引 mapping 使用 PROBE-006 已冻结的 `wide-1024` 契约，并依赖 T1b 实现及 Probe Decision Gate 集成验证。
  - 验证：真实 OpenSearch 覆盖 Alias 切换失败、切换后 PG 确认丢失、smoke 失败回滚、删除优先阻断和重建后回滚到旧分区。
- [ ] **T6 (P1, human: ~6d / CC: ~1.5d)** — Retrieval — 实现固定 Snapshot 的 ACL 前置混合检索。
  - 来源：Architecture/Performance Review，多空间查询、ACL 撤权和候选无界会产生越权及延迟尖峰。
  - 计划文件：`packages/rag-core/src/retrieval/`、`apps/api/src/modules/retrieval/`、`apps/api/src/modules/authorization/`。
  - 验证：Supertest + OpenSearch 覆盖 fan-out 2、候选 1024、超时降级、多空间冲突全序消解、`AnswerFinalizer` 冲突门禁和撤权后候选复核竞态；正式索引字段使用 PROBE-006 已冻结的 `wide-1024`，完整混合检索和生产过滤链按 Probe Decision Gate 关闭。
- [ ] **T7 (P1, human: ~6d / CC: ~1.5d)** — Answer/Citation — 建立候选生成、引用验证和最终提交三段边界。
  - 来源：Code Quality/Test Review，Answer、Citation 和 Finalizer 混写会让未验证正文成为最终事实。
  - 计划文件：`apps/api/src/modules/answer/`、`apps/api/src/modules/citation/`、`apps/api/src/modules/answer-finalizer/`、`apps/web/src/features/chat/`。
  - 范围补充：常规路径为句切分 + token 重叠 + 一次批量逐句 Embedding（P95 ≤ 2.0 s），高风险路径追加一次蕴含调用（P95 ≤ 3.5 s，且与逐句 Embedding 并发发起）；两条路径的调用都必须经 `ModelAdapter` 并计入单次 5 元口径（ADR-0027、ADR-0029）。数值于 2026-08-26 按 PROBE-005 实测修订（原 600 ms / 1.5 s）。
  - 验证：E2E 覆盖普通草稿、高风险缓冲、2,048 tokens 上限、验证失败、分层预算超时、SSE 续读和当前 ACL 引用回跳。
- [ ] **T8 (P1, human: ~6d / CC: ~1.5d)** — Deletion/Replay — 实现删除目标、墓碑、Legal Hold 和分级 Replay。
  - 来源：Architecture/Test Review，旧 Release、DLQ、Snapshot 和备份可能在删除后重新暴露正文。
  - 计划文件：`apps/api/src/modules/deletion/`、`apps/worker/src/resource-cleanup/`、`apps/api/src/modules/replay/`。
  - 验证：跨 PG/OpenSearch/MinIO/Redis/RabbitMQ/Trace 的删除证明测试及恢复演练。
- [ ] **T9 (P2, human: ~4d / CC: ~1d)** — Feedback/Evaluation — 建立反馈事件、固定黄金集和发布报告。
  - 来源：Test Review，质量指标必须绑定固定语料、Manifest、模型、Prompt、索引快照和随机参数。
  - 计划文件：`apps/api/src/modules/feedback/`、`apps/worker/src/profiles/evaluation/`、`evals/`。
  - 验证：50 题回归可重复，输出 Recall@5、引用覆盖/正确率、忠实度、拒答和成本差异。
- [ ] **T10 (P1, human: ~3d / CC: ~0.5d)** — Worker Runtime — 隔离 ingestion/evaluation 资源和预算。
  - 来源：Performance Review，评测负载不得抢占用户入库主链。
  - 计划文件：`apps/worker/src/main.ts`、`apps/worker/src/profiles/`、`infra/compose/`、`packages/config/`。
  - 验证：并行压测确认独立队列、并发、in-flight、RSS、prefetch 和预算池，超限只排队/暂停。
  - 时点：Worker Profile 启动入口和配置必须在 T3/T4 前完成；完整并行压测可在 T9 链路具备后收口。
- [ ] **T11 (P1, human: ~4d / CC: ~1d)** — Audit/Telemetry — 分离同步领域审计和异步运行遥测。
  - 来源：Code Quality/Test Review，遥测故障不能阻止业务状态提交，也不能造成领域审计缺失。
  - 计划文件：`apps/api/src/modules/audit/`、`apps/api/src/modules/telemetry/`、`packages/observability/`。
  - 验证：关闭 Trace/指标消费者后状态与审计仍提交，Outbox 恢复后遥测补投且不重复。
  - 时点：同步领域审计随 T2/T3 的业务事务落地；异步遥测消费者和恢复验证可以后置。
- [ ] **T12 (P1, human: ~4d / CC: ~1d)** — Performance/Budget — 落地查询、缓存、延迟和费用硬门禁。
  - 来源：Performance Review，N+1、无界候选、缓存过期授权和模型费用失控均会破坏本地可用性。
  - 计划文件：`packages/config/`、`apps/api/src/modules/retrieval/`、`apps/api/src/modules/model/`、`tests/performance/`。
  - 验证：配置 schema、批量查询计数、Redis 作用域缓存按 `aclRevision` 失效、分项延迟报告、用户级限流以及 5/16/500 元预算账本熔断。
  - 时点：Budget Ledger schema、预扣/结算/lease 必须在 ModelAdapter 前完成；检索性能随 T6 验证，完整性能报告在 T9 后收口。
- [ ] **T13 (P1, human: ~4d / CC: ~1d)** — Untrusted Content — 落地不可信内容隔离与三处注入检测。
  - 来源：设计复审第 9 项，注入原先只有控制项与测试项，没有检测位置、状态字段、失败行为和 DoD（ADR-0032）。
  - 计划文件：`packages/rag-core/src/safety/`、`apps/worker/src/profiles/ingestion/scan/`、`apps/api/src/modules/retrieval/`、`apps/api/src/modules/answer/`、`evals/injection/`。
  - 验证：独立注入样本集覆盖直接注入、间接注入、编码与零宽字符混淆、表格/OCR 文本注入和跨文档串联；断言 `suspected` 候选不进生成上下文、不触发外链或工具调用、`QUARANTINED` 资产不可发布、未验证正文不成为最终快照。
  - 时点：分别随 T4 解析扫描、T6 上下文准入和 T7 输出检查交付，不允许最后集中补齐。

补充任务（探针收尾复审新增，权威范围与估算拆分见各自 Ticket，本节只保留口径一致的估算头和验证项）：

- [ ] **T0 (P1, human: ~4d / CC: ~1d)** — Monorepo 与本地开发基线 — 建立 pnpm/uv 工作区、Compose、可重复初始化和 CI 入口。
  - 来源：探针收尾复审，T1a–T13 全部预设一个尚不存在的 monorepo，没有任何票据拥有工具链与包边界。
  - 计划文件：`package.json`、`pnpm-workspace.yaml`、`apps/{api,web,worker}`、`packages/{contracts,database,rag-core,config,observability}`、`services/parser/`、`infra/compose/`、CI 配置。
  - 范围补充：见 [T0 Ticket](tickets/T0-monorepo-foundation.md)。冻结 Node `22.23.1`、pnpm `10.34.5`、Python `3.12.3`；Compose 复用探针实测的 Keycloak `26.2.5`、OpenSearch `2.19.1`、RabbitMQ `3.13-management`，PostgreSQL、Redis、MinIO 无探针冻结版本，实现时选定明确标签并记录依据，不用 `latest`。
  - 验证：干净检出冻结安装、根 lint/typecheck/Vitest/pytest/build/Prisma validate、六个 core 中间件 healthy、初始化可重复执行、CI 不读取仓库外凭证也不触发付费模型调用。
- [ ] **T14 (P1, human: ~6d / CC: ~1.5d)** — Identity/Authorization — 把 Keycloak 外部事实落成业务身份与统一授权决策。
  - 来源：探针收尾复审，PROBE-001 只验证了外部身份事实，业务用户映射、Workspace 成员和 `acl_scope_key` 编译此前没有票据归属。
  - 计划文件：`apps/api/src/modules/auth/`、`apps/api/src/modules/authorization/`、`packages/contracts/src/auth/`、`apps/web/src/features/auth/`。
  - 范围补充：见 [T14 Ticket](tickets/T14-identity-authorization.md)。Token、角色或 Keycloak Group 不等于业务授权；查询前编译作用域预过滤、候选合并后批量权威复核，任何依赖不可用或超时 fail closed（ADR-0026、ADR-0037）。其中约 2d 由 T6 转移而来。
  - 验证：Keycloak 容器集成覆盖 PKCE、JWKS 轮换、过期、禁用、撤权、不可用与恢复；PG/OpenSearch 集成覆盖撤权竞态、过滤与复核一致、复核超时 fail closed，越权证据泄漏为 0。
- [ ] **T15 (P1, human: ~5d / CC: ~1.25d)** — ModelAdapter — 建立四类模型调用的统一准入层与预算门禁。
  - 来源：探针收尾复审，PROBE-005 的四条供应商路径此前分散依附在 T5/T6/T7/T12，没有单一准入点票据。
  - 计划文件：`apps/api/src/modules/model/`、`packages/contracts/src/model/`、`packages/config/`、`packages/database/`。
  - 范围补充：见 [T15 Ticket](tickets/T15-model-adapter.md)。`UNKNOWN` 或不允许出域的数据在发出 HTTP 请求前阻断；Rerank 输入取自 `RetrievalManifest.rerankInputSize`，不从前端或环境变量覆盖；调用前预扣并按 ADR-0029 结算，崩溃由 lease 回收。其中约 2d 由 T5/T6/T7/T12 转移而来。
  - 验证：四类调用契约与错误归一、SSE 事件白名单与取消、敏感/`UNKNOWN` 输入断言零网络请求、并发预扣与结算差额、429 退避降级、回显正文与密钥不落日志；LIVE 供应商测试用合成数据手工触发，不进普通 CI。
- [ ] **T16 (P1, human: ~10d / CC: ~2.5d)** — Web/Admin Surfaces — 交付用户主链页面与三个硬 DoD 管理控制台。
  - 来源：探针收尾复审，测试计划的九组路由中 `/admin/deletions`、`/admin/evaluations`、`/admin/operations` 是硬 DoD 但没有任何票据拥有页面实现。
  - 计划文件：`apps/web/src/app/`、`apps/web/src/features/`、`tests/e2e/`。
  - 范围补充：见 [T16 Ticket](tickets/T16-web-admin-surfaces.md)。按执行顺序拆为 T16a 用户主链（~6d / ~1.5d）和 T16b 管理控制台（~4d / ~1d）两批，纵向跟随后端 Ticket 交付，不等后端全部完成后一次性搭空壳页面；页面开工前完成 Design Review。其中约 1.5d 由 T7/T8/T9/T12 转移而来。
  - 验证：Playwright 覆盖登录、上传到发布、Chat/SSE/续读、撤权后引用回跳、高风险缓冲、删除证明、评测门禁和预算熔断；无障碍、错误恢复、加载/空状态按 Design Review 结果验收。

### 16.1 工作量合计与周期换算

口径：单人有效工作日。`human` 为人工实现，`CC` 为机械实现主要由 Claude Code 承担时的等价工作日。两者都只覆盖票据实现本身，不含评审、门禁关闭、集成调试、语料构建和返工。

| 分项 | human | CC |
|---|---|---|
| T1a–T13（首次工程评审已估） | 65d | 15.75d |
| T0/T14/T15/T16 全范围 | 25d | 6.25d |
| 减去已隐含在 T5–T12 内的重叠 | -5.5d | -1.4d |
| 十八张票据合计 | 84.5d | 20.6d |

重叠明细：T6 → T14 授权模块与撤权复核 -2d；T5/T6/T7 → T15 供应商客户端 -1.5d；T12 → T15 模型预算门禁 -0.5d；T7 → T16a `apps/web/src/features/chat/` -1d；T8/T9/T12 → T16b 删除证明与报告页面 -0.5d。这些工作原先已计入 T5–T12 的估算，四张新票据成立后只是归属转移，不是净新增范围；净新增为 human ~19.5d / CC ~4.9d。

周期换算是假设，不是承诺，也不替代重估：票据估算不含 DX Review、Design Review、两次增量工程复审、[Probe Decision Gate](probe-decision-gate.md) 的 11 项待关闭条件（3 项实现前决策、5 类实现集成验证、3 项生产真实数据治理）、真实业务语料构建与 `rerankInputSize` 拍板实验、性能回归、恢复演练和评审返工。按门禁密集项目 1.7–2.2 倍的经验系数换算：

- 人工为主路径约 144–186 人日，单人 5 天/周约 29–37 周，落在 24–36 周窗口的上半段，上界略微超出窗口。
- 机械实现主要由 CC 承担、人工只做评审与门禁时，实现部分压缩而门禁与集成部分不压缩，合计约 16–24 周，落在窗口下半段。

系数为经验假设值而非实测值，因此 24–36 周窗口在“人工为主”路径下已接近上界。若窗口不成立，按[产品与架构边界](../design/企业级可信RAG基础MVP-产品与架构边界.md)第 17 节优先削减首批文件格式、运营界面和影响分析覆盖面，不削减身份、权限、引用、消息幂等、发布回滚和数据删除门禁。正式重估仍按计划在 T0 后的实现准备增量工程复审中进行。

探针 Tickets：

- [PROBE-000 环境门禁](tickets/PROBE-000-environment.md)
- [PROBE-001 Keycloak/OIDC](tickets/PROBE-001-keycloak-oidc.md)
- [PROBE-002 DeepDOC Parser](tickets/PROBE-002-deepdoc-parser.md)
- [PROBE-003 OpenSearch Release/Alias](tickets/PROBE-003-opensearch-release.md)
- [PROBE-004 RabbitMQ Task Bus](tickets/PROBE-004-rabbitmq-task-bus.md)
- [PROBE-005 ModelAdapter](tickets/PROBE-005-model-adapter.md)
- [PROBE-006 分块与引用定位](tickets/PROBE-006-chunking-citation-locating.md)

## 17. Worktree 并行化策略

| 步骤 | 模块 | 依赖 |
|---|---|---|
| A 身份与授权 | `auth`, `authorization`, `web/auth` | - |
| B 资产与 Parser | `document`, `object-storage`, `parser-service` | - |
| C 数据模型与状态 | `prisma`, `domain-state`, `audit` | - |
| D 消息与任务 | `outbox`, `message-bus`, `worker` | C |
| E Release/检索 | `release`, `retrieval`, `opensearch` | B、C、D |
| F Answer/SSE | `answer`, `citation`, `web/chat` | A、E |
| G 删除/恢复/评测 | `deletion`, `evaluation`, `observability` | C、D、E、F |

建议执行顺序：先并行启动 A、B、C；合并后启动 D；再启动 E；E 完成后启动 F；最后启动 G。A 与 B/C 无共享主模块时可并行；D 与 E 共同修改任务和数据契约，必须顺序合并；F 与 G 共享 AnswerRun/Deletion 只读协议，避免同时修改公共契约。

按执行 Lane 计算为 4 条：Lane A（身份授权）、Lane B（资产与 Parser）、Lane C（数据模型）可并行；Lane D（消息 -> Release/检索 -> Answer -> 删除/评测）在前三者合并后顺序执行。跨 Lane 的共享契约先由 C 固化，避免多个工作区同时修改 `packages/contracts` 和 Prisma schema。

实现时建议在以下复杂文件加入并维护 ASCII 图：Prisma 领域模型旁的正交状态/关系图、MessageBus 编排服务的 Attempt/Generation/ACK 流程、Release Reconciler 的跨库恢复窗口、Answer Finalizer 的候选/验证/提交管道，以及删除编排器的 Target 依赖图。

## 18. 评审结论

- Scope Challenge：范围接受为“完整基座、单一客服纵向闭环”，没有继续扩大产品角色。
- Architecture：Manifest、状态机、消息、删除、SSE、Parser 和作用域已闭合。
- Code Quality：尚无本项目业务实现；通过契约优先、模块化单体和 Adapter 数量控制避免提前抽象。
- Test：已生成覆盖图和失败模式登记；实现时不得以 Mock 替代真实中间件 E2E。
- Performance：已定义硬上限、降级和测量方法；六个架构探针已完成，必须在增量工程复审中按实测重估。
- Review status：`DONE_WITH_CONCERNS`，架构方向和协议已闭合，剩余关注是探针实测、实现验证和容量重估。

### Completion Summary

- Step 0 Scope Challenge：范围接受为“完整基座、单一客服纵向闭环”。
- Architecture Review：8 项问题，全部固化到协议。
- Code Quality Review：7 项边界问题，全部按最少正式 Adapter 和明确模块职责处理。
- Test Review：覆盖图已生成，6 类新增协议缺口已纳入 P1 测试门禁。
- Performance Review：5 项问题，全部固化为资源、查询、缓冲、缓存和费用硬上限。
- NOT in scope：已写入第 1 节。
- What already exists：已写入第 2 节，参考仓库只作固定快照和 Harness 对照。
- TODOS.md：0 项；当前有价值的工作已进入 T0、T1a/T1b、T2-T16，没有另建模糊延期项。
- Failure modes：登记 F-01 至 F-30（F-30 于 2026-08-26 按 PROBE-005 Stage C 实测新增：供应商 429 被误当作契约裁决或排序结果，探针自身曾因此得出「`top_n` 不生效」的错误结论）；设计层面 0 个未处理 critical gap，六个探针实测已完成，业务实现与集成测试尚未开始。
- Outside voice：已运行独立 CEO challenge 和设计文档对抗性审查，已批准发现均已折入方案。
- Parallelization：4 条 Lane，其中 3 条可并行，1 条为依赖合并后的顺序主链。
- Lake Score：26/26 项推荐选择完整方案，没有用 Happy Path 换取短期进度。

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|---|---|---|---:|---|---|
| CEO Review | `/plan-ceo-review` | 产品范围与策略 | 1 | CLEAR | 完整基座、客服单主链，高级能力后置 |
| Codex/Outside Voice | 独立 challenge | 独立反证 | 2 | CLEAR WITH MINOR CONCERNS | 关键矛盾已修订，文档评分 9.0/10 |
| Eng Review | `/plan-eng-review` | 架构、测试与性能 | 1 | CLEAN (PLAN) | 26 项发现均已固化，0 个设计层 critical gap；探针实测已完成，业务实现与集成测试尚未开始 |
| Design Review | `/plan-design-review` | UI/UX 缺口 | 0 | NOT RUN | 当前为架构方案，进入页面实现前再执行 |
| DX Review | `/plan-devex-review` | 本地开发体验 | 0 | NOT RUN | 实现仓库、Compose 和启动链建立后执行 |

两项 `NOT RUN` 不是可以无限期挂起的状态，必须绑定明确触发点：

- Design Review 在页面实现开始前执行，最迟不晚于 `/chat` 与三个 `/admin/*` 控制台开工。`/admin/deletions`、`/admin/evaluations`、`/admin/operations` 是硬 DoD，删除证明、预算熔断和恢复演练必须有界面可人工验证，所以它们的信息架构不能在没有 Design Review 的情况下直接实现。
- DX Review 在仓库骨架、Docker Compose Profile 和一键启动链建立之后、T3 RabbitMQ/Outbox 实现之前执行，因为本地启动、种子数据和探针复用方式一旦固化，后期更换成本高。
- 两项执行完成前不得声明阶段 1 交付增量的 UI 或本地开发体验已闭合；`DONE_WITH_CONCERNS` 的“concerns”包含这两项未执行。

**CROSS-MODEL:** 两次独立审查与工程评审共同认为 TS 模块化单体、PostgreSQL/OpenSearch/RabbitMQ/MinIO/Keycloak、固定 DeepDOC Adapter 和客服单主链方向成立；主要风险集中在协议一致性和实测，而不是需要换架构。

**VERDICT:** CEO + OUTSIDE VOICE + ENG CLEARED。六个架构探针现已完成外部事实验证，允许进入受 Probe Decision Gate 约束的纵向实现；`DONE_WITH_CONCERNS` 表示尚无业务实现和集成验证，不表示仍有架构方向未决定。

六个架构探针已经给出登录/撤权、资源峰值、解析质量、OpenSearch 延迟与 kNN 初始参数、模型费用和分块冻结参数；真实业务规模、完整过滤链、服务层集成和周期重估仍是实施验证项，不是开放架构决策。

当前没有待解决的“架构方向”选择，但仍有实现门禁和生产治理条件，不能以本记录的设计审查结论代替：`rerankInputSize` 产品取舍、ModelAdapter 数据分级门禁与 PostgreSQL 预算账本集成、Parser/Worker 和 AMQP 线级测试、真实业务语料检索回归，以及 fluxionai 模型身份和数据留存评估。逐项关闭条件见 [Probe Decision Gate](probe-decision-gate.md)。
