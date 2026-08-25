# TypeScript 企业级可信多模态 RAG 技术设计方案

> 版本：V1.4  
> 日期：2026-08-21  
> 适用范围：企业内部知识库、复杂文档解析、混合检索、句级引用和权限治理

## 1. 设计结论

推荐采用 **Next.js 前端 + NestJS TypeScript 控制面 + Node Worker + Python/模型服务数据面** 的架构：

```text
TypeScript：Web、NestJS API、权限、SSE、查询编排、任务编排、引用校验、运营后台
Python/模型运行时：DeepDOC/OCR、Embedding、Reranker、LLM 推理
存储：PostgreSQL + OpenSearch + Redis + MinIO（未来云端部署可切换阿里云 OSS）
```

这里的 MVP 指“范围受控的企业级基础版本”，不是一次性 Demo。首期可以只交付客服工作台和有限数据源，但身份、权限、版本、异步任务、索引发布、引用、审计、评测和恢复边界必须按正式产品设计。后续增加研发工作台、连接器或 GraphRAG 时，应通过新增 Adapter、策略和投影扩展，不修改主领域模型或重建主链路。

首期不建议把所有解析和模型能力重写成 TypeScript，也不建议一开始部署 MongoDB、Neo4j、Kafka、多个向量数据库。当前目标是先用合成/严格脱敏资料把一条可观测、可回滚、可验收的主链路跑通；Next.js + NestJS 可以保留，但先做模块化单体，不拆成多套微服务：

```text
上传文档
  -> 安全扫描与权限登记
  -> 异步解析 / 分块 / 关键词与向量投影
  -> ACL 前置的 BM25 + 向量混合检索
  -> 融合 + Reranker Top5
  -> LLM 生成
  -> 句级引用校验与无据句处理
  -> SSE 返回答案、引用和任务进度
```

架构图源文件：

- [架构图 Mermaid 源文件](diagrams/ts-rag-architecture.mmd)

当前环境的离线浏览器渲染服务无法绑定 localhost，因此 SVG、PNG 和 Excalidraw 产物尚未生成。Mermaid 源文件可以直接导入 Mermaid Live、VS Code Mermaid 插件或项目文档流水线渲染。

## 2. 设计目标与非目标

### 2.1 目标

- 支持 PDF、Office、图片、扫描件、表格和后续音视频的统一知识资产管理。
- 检索前完成租户、组织、文档 ACL、密级和有效期过滤。
- 支持 BM25、向量、加权融合、Reranker 和证据闸门。
- 每个事实性句子都能绑定到不可变文档版本和原文位置。
- 所有解析、索引、检索、生成和引用过程可追踪、可重放、可回滚。
- 支持流式问答、临时文件 quick_parse、模型降级和异步失败重试。
- 以稳定的领域实体、事件契约、Adapter 协议和版本化配置承载后续扩展，避免因新增数据源或模型而重写主链路。

### 2.2 非目标

- 首期不做通用 Agent 平台，不开放任意写操作工具。
- 首期不默认引入图数据库、MongoDB、Kafka 和独立向量数据库。
- 不展示模型原始 Chain-of-Thought，只展示任务进度、证据摘要和可审计 Trace。
- 不把“引用覆盖率”当成唯一质量指标，必须同时评估引用正确率、忠实度和拒答质量。

### 2.3 基座级 MVP 的完成标准

以下能力属于 MVP 的基础设施，而不是可以以后补的“演示增强项”：

- 身份、租户、工作台成员和文档 ACL 可审计，检索、引用、预览和下载使用同一授权策略。
- 文档版本不可变；审核状态、处理状态、索引投影状态和删除保留状态分开保存。
- 入库通过 PostgreSQL Outbox + RabbitMQ 异步执行，任务可重试、幂等、进入 DLQ、按步骤重放。
- 索引以 `index_release` 管理，构建、校验、激活和回滚均有记录，禁止直接覆盖线上 Alias。
- 解析、分块、Embedding、Reranker、Prompt 和模型路由均记录版本，回答可以重现当时使用的证据和配置。
- 问答 Run、引用验证、拒答、降级、取消和错误均可查询，SSE 断线后可以读取最终快照。
- 有固定黄金集、权限专项测试、解析专项测试、引用正确性测试和恢复演练；候选质量指标未达标时不能伪装成生产结论。

### 2.4 明确后置但不破坏基座的能力

企业级基础 MVP 不等于一次性交付所有企业功能。以下能力暂不实现完整产品形态，但必须能够通过既定契约接入：

- GraphRAG、RAPTOR、ColBERT/Multi-vector 和 Agentic Retrieval。
- Git、Confluence、SharePoint、企业网盘和真实工单连接器。
- 音视频、多模态向量、跨语言检索和长期记忆。
- 本地大模型、GPU 调度、私有 Kubernetes、多地域灾备和动态插件市场。
- 完整 ABAC 策略设计器、外部权限同步和自动化知识编译运营台。

这些能力后置的是具体实现和运营界面，不是数据版本、权限范围、证据协议、任务契约和 Adapter 边界。

## 3. 总体架构

完整架构图见 [ts-rag-architecture.mmd](diagrams/ts-rag-architecture.mmd)。逻辑分为五层：

| 层级 | 主要组件 | 主要职责 |
|---|---|---|
| 体验层 | Next.js/React、TypeScript SDK | 文档管理、问答、引用回跳、SSE、运营后台 |
| 控制层 | NestJS API/BFF、Query Orchestrator、Document Service、Citation Service | 认证、授权、业务 API、查询编排、文档状态机、引用校验 |
| 异步数据面 | RabbitMQ、Node Worker、Python DeepDOC Worker、Index Projection Worker | 解析、OCR、表格还原、分块、Embedding、关键词/向量投影、发布和重试 |
| 数据层 | PostgreSQL、OpenSearch、Redis、MinIO/阿里云 OSS | 业务事实、检索索引、短期状态和文件/解析产物 |
| 模型与运维 | NestJS 内部 ModelAdapter、OpenTelemetry | Chat、Embedding、Reranker、引用验证的模型路由、重排、降级、Trace、指标和日志；阶段 1 不单独部署 Model Gateway |

### 3.1 异步消息总线：RabbitMQ

异步入库和索引投影统一使用 RabbitMQ。它负责跨 Node.js Worker 与 Python Parser Service 的任务传递，不负责保存业务事实；业务状态仍以 PostgreSQL 的 `ingestion_job`、`ingestion_step`、`step_attempt`、`outbox_event` 和 `dead_letter` 为准。

```text
PostgreSQL 事务写入 Outbox
        -> Outbox Relay（Publisher Confirm）
        -> rag.tasks.topic Exchange（durable）
        -> 按 routing key 投递到任务队列
           ├─ rag.ingestion.parse
           ├─ rag.ingestion.chunk
           ├─ rag.ingestion.embedding
           ├─ rag.projection.keyword
           ├─ rag.projection.vector
           ├─ rag.release.validate
           ├─ rag.resource.cleanup
           └─ rag.evaluation.run
        -> Worker 手动 ACK / 临时失败进入 rag.retry.topic
        -> 30 秒 / 5 分钟 / 30 分钟 TTL 重试队列
        -> 到期后重新路由到 rag.tasks.topic
        -> 超过重试上限进入 rag.tasks.dlx / 应用 dead_letter
```

消息只携带 `eventId`、`documentVersionId`、`indexReleaseId`、`projectionType`、`contentHash`、`schemaVersion`、`traceId` 和重试上下文，不携带正文或大文件。队列和消息启用持久化；生产者使用 Publisher Confirm 和 mandatory routing，消费者使用手动 ACK，处理成功后才确认。临时错误通过 RabbitMQ 原生 TTL + DLX 重试队列处理，不依赖延迟消息插件；永久错误或超过上限的消息进入死信交换机，并同步写入 PostgreSQL `dead_letter` 供人工查看和重放。只有在重试消息或死信消息获得 Publisher Confirm 后，消费者才能 ACK 原消息，避免失败窗口丢任务。

本地单节点使用 durable classic queue 控制资源占用；进入真实试点后使用三节点 RabbitMQ 和 quorum queue。每类 Worker 独立设置 prefetch、并发、超时和租户配额，防止大文件解析挤占轻量任务。MVP 由 Node Worker 消费任务并调用 Python Parser HTTP 接口，以保持任务状态写入集中；以后需要独立扩缩容 Parser 时，Python Worker 可以直接消费同一版本化消息契约。

RabbitMQ 客户端封装在 `MessageBus` Adapter 中，业务模块只依赖事件契约，不直接依赖 amqplib 的 Channel、Exchange 或 Queue DTO。未来如需要 NATS JetStream/Kafka，只替换 Adapter 和部署配置，不改变 Outbox、事件契约、任务状态或幂等规则。

### 3.2 推荐部署形态

首期使用一个 TypeScript 单体控制面和多个异步 Worker：

```text
apps/web                 Next.js 前端
apps/api                 NestJS API/BFF
apps/worker              共享 Worker 代码库
  profile:ingestion      文档解析、分块、向量化、索引任务
  profile:evaluation     黄金集评测和回归任务
packages/contracts       OpenAPI/TypeScript DTO/Zod Schema
packages/rag-core        检索预算、证据协议、引用状态机
services/parser          Python DeepDOC/OCR 适配服务
packages/model-adapter   NestJS 内部 Chat/Embedding/Reranker/引用验证 统一入口
```

控制面先保持模块化单体，避免过早拆成多个网络服务。解析因为 Python 运行时和资源特征独立为服务。入库与评测共享 `apps/worker` 代码库和基础设施模块，但通过 `ingestion`、`evaluation` 两个启动 Profile 运行成独立进程，分别绑定队列、并发、资源限制和扩缩容策略，避免黄金集评测挤占在线入库。Chat、Embedding、Reranker 和高风险引用验证先通过 NestJS 内部 `ModelAdapter` 调用云 API，不部署独立模型网关。只有一名开发者并不意味着取消 NestJS，而是要求严格控制模块数量、复用类型契约，并用 AI 辅助生成测试和样板代码。

### 3.3 共享基座与角色工作台

客服、研发和普通员工不应各自复制一套系统。推荐采用：

```text
共享基座
  身份 / 租户 / ACL / 文档版本 / 任务编排 / 混合检索 / 引用 / 模型路由 / Trace / 评测
        +
角色工作台
  客服工作台 / 研发工作台 / 普通员工工作台 / 后续业务工作台
```

“角色工作台”不是 Git 分支，也不是三套独立后端，而是由配置和少量领域模块组合出的产品视图。每个工作台绑定一个或多个知识空间、数据连接器、检索策略、回答策略和工具白名单。

同一个业务用户可以加入多个工作台，并在每个工作台拥有不同角色。例如产品专家在客服工作台中负责知识审核，同时在研发工作台中是普通成员。工作台角色不能替代全局平台角色，也不能绕过知识空间和文档 ACL。

| 工作台 | 主要知识源 | 专属能力 | 关键约束 |
|---|---|---|---|
| 客服工作台 | 正式产品资料、标准话术、脱敏工单知识、FAQ | 工单上下文、回复草稿、相似案例、升级建议 | PII 脱敏；正式产品知识优先；默认人工审核后发送 |
| 研发工作台 | 代码仓库、API 文档、设计文档、Issue/PR、故障记录 | 代码/符号检索、版本和分支过滤、文件行号引用、故障排查 | 必须绑定 commit/branch；不能把未授权代码带入其他工作台 |
| 普通员工工作台 | 制度、流程、培训资料、公告、FAQ | 简化问答、流程步骤、相关制度推荐 | 默认不开放工单、源代码和敏感运营数据 |

共享基座保证安全和可信行为一致；工作台只允许配置业务差异。禁止通过工作台 Prompt 绕过 ACL、引用验证、数据分级、费用预算和审计。

建议在 PostgreSQL 中把工作台建模为策略组合，而不是复制服务：

```text
workspace
workspace_member / workspace_role
workspace_source_binding
workspace_retrieval_policy
workspace_answer_policy
workspace_tool_policy
workspace_evaluation_suite
```

OpenSearch 文档统一带 `tenant_id`、`knowledge_space_id`、`index_partition_id`、`source_type`、`product_id`、`version`、`branch`、`valid_from`、`valid_to` 和 ACL 字段。物理索引和版本化 Alias 的默认作用域是 `tenant_id + knowledge_space_id + IndexPartition`；工作台通过绑定知识空间和策略组合查询范围，不复制索引。只有在高安全、超大规模或强隔离要求下，才为额外的物理安全域建立独立索引。

文档版本应建模为共享知识资产，而不是绑定死在单一工作台。工作台通过 `workspace_source_binding` 绑定共享版本，并附加自己的检索、回答和工具策略。这样同一份产品手册可以服务客服、研发和普通员工，同时保持不同工作台的授权和排序差异。

首期只完整交付客服工作台。研发和普通员工工作台先保留共享协议、数据模型和扩展 seam，不在 MVP 同时接完代码仓库、制度库和全部专属工具，避免三个垂直场景一起稀释黄金集和验收标准。

## 4. 中间件与基础组件选型

### 4.1 P0 组件

| 组件 | 推荐选择 | 用途 | 选型边界 |
|---|---|---|---|
| Web | Next.js + React + TypeScript | 问答、知识库、后台、SSR/CSR | 不把检索逻辑放浏览器 |
| API | NestJS + Fastify + TypeScript | REST、SSE、鉴权、业务编排 | API 只编排，不执行长时间解析 |
| 参数校验 | Zod 或 class-validator | 请求、环境变量、模型响应校验 | 所有外部响应进入边界校验 |
| 主库 | PostgreSQL 16+ | 租户、用户、ACL、文档、版本、任务、审计、引用 | 事实数据唯一来源 |
| PostgreSQL 访问 | Prisma + Prisma Migrate | 关系模型、事务、类型安全查询和数据库迁移 | 特殊索引/扩展使用自定义 SQL migration；不管理 OpenSearch |
| 检索 | OpenSearch | BM25、kNN、过滤、聚合、混合召回 | 向量维度和索引版本必须可配置；OpenSearch 客户端封装在 RetrievalModule 内部，业务编排依赖 RetrievalChannel 契约 |
| 异步总线 | RabbitMQ 4.x | 文档解析、分块、Embedding、索引投影、发布校验、清理和评测任务；确认、手动 ACK、重试和 DLQ | P0 使用 RabbitMQ；通过消息契约隔离实现，超大规模再评估 NATS JetStream/Kafka |
| 缓存/协调 | Redis 7 | 缓存、限流、短期会话、quick_parse TTL、分布式锁和 SSE 辅助状态 | 不承担异步任务的唯一事实；不承载应用任务队列 |
| 文件 | MinIO（MVP）；阿里云 OSS（未来云端） | 原文件、图片、解析产物、引用快照 | 通过对象存储适配器接入；文件内容不经过 API 转存 |
| 身份 | Keycloak + OIDC | 登录、会话、MFA、粗粒度角色和 Token | PostgreSQL 仍负责组织、成员关系和文档 ACL |
| 模型接入 | MVP 使用 NestJS 内部 ModelAdapter 连接阿里云百炼；后续再评估 LiteLLM/独立 Model Gateway | Chat、Embedding、Reranker、引用验证、超时、费用统计 | 仅处理合成/严格脱敏数据；首月预算 500 元；敏感资料不得外发 |
| 观测 | OpenTelemetry + Prometheus + Grafana + Loki/Tempo | Trace、指标、日志和链路检索 | Trace ID 贯穿 SSE 和异步任务 |

### 4.2 未来试点容量基线

以下数据只用于未来真实试点的容量规划，不是当前流程验证 MVP 的实现目标，也不是已实测结果：

| 指标 | 试点基线 |
|---|---:|
| 客服用户 | 100 |
| 日问答量 | 5,000 |
| 峰值并发 | 30 |
| 文档规模 | 10 万份 / 约 500 GB |
| 日新增工单 | 2 万 |
| 单文件上限 | 200 MB |
| TTFT | P95 ≤ 3 秒 |
| 完整回答 | P95 ≤ 15 秒 |

当前 MVP 只需要用几十份知识文档、数百条合成工单和几十道黄金题验证行为正确性。进入真实试点前再按上表执行容量评审，并区分在线问答流量与离线解析流量。

### 4.3 P1 组件

- GraphRAG/RAPTOR：仅在多跳黄金题有稳定增益后引入。
- NATS JetStream/Kafka：当事件消费方超过数个、需要跨团队订阅、需要超长事件保留或 RabbitMQ 吞吐/路由模型成为瓶颈时评估。
- MongoDB：只有正文结构、查询模式和独立扩缩容需求被数据证明后引入。
- Neo4j/图数据库：只有实体关系、多跳路径和冲突治理有明确收益后引入。
- 音视频处理：ASR、关键帧、时间点引用作为独立 Worker，不阻塞文档主链路。

### 4.4 与当前 ragent/RAGFlow 代码的关系

本节基于当前工作区固定快照：ragent `16984b95454d3fc2a55b60ade1950fefeba339ec`，RAGFlow `618c4599b10e792a5eaf3dee9c1cbe7c741c4803`。

当前两个仓库不建议直接作为 TypeScript API 的内部依赖，而应放在适配器之后：

不要把上游仓库中的单个文件当成可独立复用的模块。RAGFlow DeepDOC 当前会依赖 `common`、`rag`、`api` 等内部包；ragent 则是带 Spring 多模块、Milvus、RocketMQ 和 Sa-Token 等基础设施的 Java 工程。直接复制文件会把隐含依赖、配置和许可证维护成本带进新项目，后续升级也难以追踪。

消息队列选型也不按仓库名称照搬：ragent 固定快照使用 RocketMQ 处理文档分块和资源清理；RAGFlow 固定快照提供消息队列抽象，当前默认 `ingestor.mq_type=nats`，同时保留 Redis/RabbitMQ 等配置和管理能力。两者共同证明的是“耗时入库任务需要可靠异步化”，而不是必须采用同一种 Broker。本项目选择 RabbitMQ，是为了匹配 PDF 参考链路、Node/Python 客户端成熟度、可观察的路由/确认/DLQ 机制和未来 Worker 独立扩缩容。

| 现有代码 | 接入方式 | 责任归属 |
|---|---|---|
| ragent Java 检索链路 | 仅在架构探针或评测 Harness 中通过临时 REST/gRPC 对比，或将其预算、融合、证据闸门规则迁移到 `packages/rag-core` | TS 控制面负责租户、ACL、请求编排；ragent 不作为阶段 1 正式运行时实现 |
| RAGFlow DeepDOC/解析器 | `ParserAdapter` 调用独立 Python Worker 或容器 API | Python 负责布局、OCR、表格和解析产物；TS 负责任务状态、版本和发布 |
| RAGFlow `insert_citations` 思路 | 在 `CitationModule` 中实现等价策略，保留 token/vector 回填作为候选绑定 | TS 负责引用协议、权限复核、蕴含校验和最终展示 |
| RAGFlow/Ragent 模型路由 | 阶段 1 通过 NestJS 内部 `ModelAdapter` 接入阿里云百炼；LiteLLM/独立模型网关仅作为后续替换方案 | TS 负责预算、路由策略、审计和降级状态 |

适配器接口只暴露稳定的业务协议，不把第三方仓库的内部 DTO、数据库表或索引字段泄漏到前端。这样可以先复用现有实现，再逐步替换为自有实现：

```ts
interface ParserAdapter {
  submit(input: ParseInput): Promise<ParserTaskAccepted>;
  get(taskId: string): Promise<ParserTaskStatus>;
  cancel(taskId: string, reason: string): Promise<void>;
}

interface ModelAdapter {
  streamChat(input: ChatInput, context: ModelCallContext): AsyncIterable<ChatDelta>;
  embed(input: EmbeddingInput, context: ModelCallContext): Promise<number[][]>;
  rerank(input: RerankInput, context: ModelCallContext): Promise<RerankResult[]>;
  verifyCitation(
    input: CitationVerificationInput,
    context: ModelCallContext,
  ): Promise<CitationVerificationResult>;
}

type ModelCallContext = {
  tenantId: string;
  purpose: "chat" | "embedding" | "rerank" | "citation_verification";
  dataClass: "UNKNOWN" | "PUBLIC" | "INTERNAL" | "CONTROLLED" | "SENSITIVE";
  executionZone: "CLOUD" | "LOCAL";
  modelRef: string;
  budgetReservationId: string;
  traceparent: string;
  signal: AbortSignal;
};
```

迁移顺序建议是：先用 RAGFlow 解析器验证复杂文档，再用 TS 统一入库和检索协议；ragent 的 Java 检索链路只作为架构探针或评测 Harness 的外部对照，不进入阶段 1 正式请求链路。

所有云端 Chat、Embedding、Reranker 和引用验证模型必须位于 `ModelAdapter` 之后。MVP 可以选用一个兼容 OpenAI 协议的云服务跑通流程，但业务模块不得导入具体供应商 SDK，也不得把供应商模型名写进领域数据模型。

### 4.5 前瞻性扩展边界

为了避免后续加入代码仓库、GraphRAG、多向量检索或新模型时重写主链路，MVP 固定以下少量高价值 seam。seam 是明确的可替换边界，不等于现在就建设通用插件平台：

| 扩展边界 | 稳定输入输出 | 可扩展实现 |
|---|---|---|
| `SourceConnector` | 外部源游标/事件 → `SourceDocumentSnapshot` | 文件导入、工单、Git、Confluence、网盘 |
| `ParserAdapter` | `ParseInput → ParserTaskAccepted/ParserTaskStatus → ParseArtifact` | DeepDOC、Office、代码、音视频 |
| `ChunkingStrategy` | `ParseArtifact → ChunkManifest`（参数由 PROBE-006 冻结） | 层级分块、Parent-child、表格、代码符号、后续 Late Chunking |
| `ProjectionBuilder` | 文档版本 + 配置版本 → 不可变投影 | BM25、Dense Vector、未来 ColBERT/Multi-vector、Graph |
| `RetrievalChannel` | `RetrievalQuery + RetrievalScope → EvidenceCandidate[]` | BM25、向量以及未来的图谱、SQL/API、代码符号检索 |
| `FusionRerankPolicy` | 多路候选 → 有解释的证据排序 | RRF、加权融合、Cross-Encoder、后续学习排序 |
| `ModelAdapter` | 版本化 Chat/Embedding/Rerank/引用验证请求 | 阿里云百炼、LiteLLM、本地模型、其他云模型 |
| `CitationVerifier` | 回答句 + 证据 → 验证结果 | token/vector 回填、NLI、规则校验、人工复核；涉及模型的调用统一经 `ModelAdapter.verifyCitation` |
| `ObjectStorageAdapter` | 上传会话、预签名、临时对象提升、校验、认领、删除和孤儿扫描 | MinIO、未来阿里云 OSS |

扩展边界遵循四条约束：

- 核心领域只认识内部契约，不导入供应商 SDK、第三方 DTO 或具体索引字段。
- 事件和解析产物带 `schemaVersion`；消费者至少兼容当前和上一版本，升级使用 expand/migrate/contract，不做大爆炸切换。
- 检索、回答、解析和模型配置使用不可变版本记录；新策略先 shadow 运行或灰度，再成为默认策略。
- MVP 不实现动态安装第三方代码的运行时插件市场。先使用代码级注册表和依赖注入，真实出现跨团队独立交付需求后再升级插件机制。

### 4.6 TypeScript 工程组织

使用 pnpm workspace 单仓库，不引入 Nx：

```text
apps/web                 Next.js 客服工作台和管理页面
apps/api                 NestJS REST、SSE、鉴权和业务编排
apps/worker              RabbitMQ 入库、索引和评测任务；按 ingestion/evaluation Profile 启动独立进程
packages/contracts       Zod Schema、请求响应和事件契约
packages/domain          领域值对象、状态和业务规则
packages/rag-core        检索预算、证据协议、引用状态机
packages/model-adapter   云端 Chat、Embedding、Reranker、引用验证的内部适配模块
packages/database        Prisma Schema、Client 和 migrations
services/parser          Python Parser Service
infra/compose            本地完整中间件和应用编排
```

`packages/database` 只服务 PostgreSQL。OpenSearch、Redis 和对象存储 Adapter 分别位于拥有该行为的后端模块，不伪装成 Prisma Repository。Prisma 生成的类型不直接作为 HTTP 契约；外部请求、模型响应和队列消息统一通过 `packages/contracts` 的 Zod Schema 校验。

## 5. 前端职责与边界

### 5.1 前端模块

| 模块 | 职责 | 不应承担 |
|---|---|---|
| `chat` | 对话列表、SSE 增量渲染、停止/重试、推荐追问 | 自行判断引用是否正确 |
| `citation-viewer` | 引用角标、来源面板、页码/bbox/表格/时间点回跳 | 绕过 API 直接读取对象存储 |
| `knowledge-base` | 知识库、文档、版本、审核、权限管理 | 在浏览器实现 ACL 规则 |
| `ingestion-console` | 任务状态、失败原因、重试、DLQ、索引发布 | 直接启动后台进程 |
| `evaluation-console` | 黄金题、实验版本、指标趋势、破线状态 | 只展示平均分而隐藏长尾 |
| `admin` | 租户、组织、模型、配额、审计 | 保存 API Key 或模型密钥 |

前端使用同一套应用壳和路由框架，根据用户可访问的工作台动态展示菜单和能力。工作台差异通过服务端返回的 capability/profile 驱动，不在前端为客服、研发、普通员工维护三套业务分支。

### 5.2 MVP 页面清单

首期页面限定为一条完整客服知识闭环：

```text
/login                       Keycloak 登录入口
/chat                        客服问答、证据和回复草稿
/knowledge                   知识文档列表
/knowledge/upload            Markdown/PDF 上传
/knowledge/:id               文档版本、适用范围和解析结果
/ingestion                   入库任务、失败原因和重试
/ingestion/:jobId            单个任务的解析、投影、Release、重试与 DLQ 明细
/review                      候选知识审核与发布
/admin/users                 用户和工作台成员
/admin/deletions             删除请求、目标状态、Legal Hold、墓碑和删除证明
/admin/evaluations           黄金题、运行结果、门禁报告和成本
/admin/operations            Worker Profile、队列积压、预算熔断、删除阻断和恢复演练
```

路由只有两个命名层：工作台页面在顶层，管理与治理控制台统一在 `/admin/*` 下。`/admin/deletions`、`/admin/evaluations` 和 `/admin/operations` 是 P0 门禁与测试计划要求的可交互界面，不是可选项；删除证明、预算熔断和恢复演练必须有界面可查，否则相关硬门禁无法人工验证。

quick_parse 不单独占一个路由：它是 `/chat` 内的会话级临时资料面板，负责上传、解析状态、TTL 剩余时间和 `FULL/METADATA_ONLY/EXPIRED` 降级提示。它复用主系统的文件安全、Parser、注入检查和外发策略，但临时产物不进入正式 Release。quick_parse 可以产生会话级 `TEMPORARY` 引用，引用只在会话和保留期内可点击回原文；清理后转为 `EXPIRED`/墓碑，不作为长期正式知识来源，会话结束或 TTL 到期后由 Cleanup Worker 清理。

模型、连接器、工作台策略和完整审计中心首期不建设通用可视化配置页面，先使用受控配置和少量管理接口。

### 5.3 前端状态原则

- 服务端事实使用 TanStack Query/SWR 管理，避免复制一份文档和任务状态。
- UI 状态只保存当前会话、筛选条件、展开状态和 SSE 临时缓冲。
- 引用、权限、版本等字段直接使用 API 契约，不建立第二套前端领域模型。
- SSE 消息使用带 `event` 和 `seq` 的协议，断线后按 `run_id` 查询快照并继续，而不是拼接重复文本。

### 5.4 SSE 事件协议

```ts
type ChatEvent =
  | { event: "run.started"; runId: string; seq: number }
  | { event: "retrieval.started"; runId: string; seq: number }
  | { event: "evidence"; runId: string; seq: number; evidence: EvidenceRef[] }
  | { event: "answer.delta"; runId: string; seq: number; text: string }
  | { event: "answer.completed"; runId: string; seq: number; answer: Answer }
  | { event: "run.failed"; runId: string; seq: number; code: string; message: string };
```

前端展示 `retrieval.started`、`evidence` 和阶段进度，不展示模型隐藏思考链。

## 6. 后端模块职责

建议在 NestJS 中采用以下模块边界：

```text
AuthModule             OIDC/JWT、用户上下文、租户上下文
AuthorizationModule    RBAC/ABAC、ACL 编译、权限解释
KnowledgeModule        知识库、目录、标签、成员和配额
DocumentModule         上传、版本、四态审核、生效/失效、软删除
IngestionModule        Outbox、投影任务状态、幂等、重试、DLQ
RetrievalModule        查询理解、ACL filter、BM25/向量、融合、Rerank
AnswerModule           Prompt、模型路由、候选答案生成、停止和降级
CitationModule         句切分、引用回填、蕴含校验、无据句处理和候选修订
AnswerFinalizer        校验通过后的最终 AnswerRun 快照、最终事件和可复制结果
EvaluationModule       黄金集、离线回归、指标和发布门禁
AuditModule            状态迁移、授权、发布、删除等领域审计的事务内写入
TelemetryModule        Trace、Token、成本和高频运行遥测的异步投递
```

### 6.1 Auth/Authorization

- 从 OIDC Token 建立 `tenantId/userId/departmentIds/roles/clearance` 上下文。
- 由 PostgreSQL 把主体授权编译为作用域集合，再写成 OpenSearch filter；所有检索通道复用同一个 `RetrievalScope`。
- 候选合并后对候选集做一次批量 PostgreSQL 权威复核，覆盖文档级拒绝例外、墓碑、Legal Hold 和有效期；预算 P95 <= 60 ms，不计入检索 250 ms。
- 预览、下载、引用展开和导出再次检查授权，不信任前端传入的证据 ID。
- 权限变更递增 `aclRevision`，用于失效 Redis 中"主体 → 允许作用域集合"缓存；只有当作用域键本身的组成属性变化时才需要重投影索引。Redis 不缓存最终授权结论与复核结果。

### 6.2 Document/Ingestion

- 文档采用“审核状态”和“处理状态”两个正交状态。审核状态为 `Draft -> PendingReview -> Published -> Archived`；解析、关键词投影和向量投影分别记录处理状态。图谱投影是阶段 2 以后可新增的状态轴，阶段 1 不创建图谱任务或表。
- 新文档版本在 `Draft` 或 `PendingReview` 阶段即可完成安全扫描、解析、分块、Embedding、候选投影和质量校验，但这些投影只能写入候选 `index_release`，不能被线上检索 Alias 访问。
- `Published` 表示业务审核通过，不代表后台此刻才开始做第一次解析。发布命令必须验证必需投影已经 `READY`；随后在同一发布编排中激活文档版本和对应 `index_release`。新版本未就绪时，旧的已发布版本继续服务。
- 上传采用临时对象与业务认领两阶段协议：预签名 URL 只能写入 `tmp/{tenantId}/{uploadSessionId}`；`complete` 校验对象存在、大小、MIME、哈希和租户归属后，服务端将对象复制/提升到内容寻址的正式 Key，再在同一 PostgreSQL 事务中写入 `document_version`、对象认领记录和 Outbox 事件。正式对象只有在认领记录存在且校验通过后才进入业务读取范围。
- `upload_session` 保存租户、预期哈希/大小、临时 Key、过期时间、完成请求幂等键和清理状态。上传中止、校验失败、响应丢失或 PG 事务失败时，临时对象和未认领正式对象由 Cleanup Worker 按 TTL 扫描、复核哈希并删除，保存删除证明；不能依赖人工清理。
- 使用 `document_version_id + content_hash` 作为幂等键；同一版本重复上传不得重复建索引。
- 每个步骤记录本次实际使用的 parser、chunker、embedding、reranker 和 prompt 版本。阶段 1 不创建图谱抽取步骤或版本字段；未来启用图谱投影时通过新 ADR 和版本化投影契约增加。
- 任务失败保留成功步骤，重试从失败步骤继续；超过次数进入 DLQ。
- PostgreSQL 的 `ingestion_job / ingestion_step / step_attempt` 是任务事实源；RabbitMQ 只负责投递、确认、消费和重试调度。即使 RabbitMQ 中的消息丢失，也能从 PostgreSQL Outbox 对账并重新派发未完成任务。
- Worker 使用 lease、heartbeat 和超时回收处理进程崩溃；租户级并发、文件大小和模型调用配额用于背压，避免大文件或单租户占满 Worker。
- RabbitMQ 消费采用至少一次投递语义，不承诺 exactly-once；每个有副作用的步骤都使用业务幂等键，并在外部写入后记录可对账的结果标识。Publisher Confirm 只确认消息到达 RabbitMQ，不等同于业务处理成功。
- MVP 首批发布门禁支持 Markdown、原生/扫描 PDF 和 JSON/CSV 工单。DOCX/PPTX/XLSX 先通过 Parser 探针和专项样本验证，按格式逐项纳入发布门禁；图片独立上传、音视频和网页连接器延后。
- Parser Service 以独立 Python HTTP/队列服务包装固定版本的 RAGFlow DeepDOC 能力；Office/PPTX/XLSX 通过专用 Parser Adapter 接入。NestJS 只依赖 `ParseInput -> ParseArtifact` 契约，不直接访问 RAGFlow 数据库或内部任务表。Office 格式只有在探针样本、定位质量、失败恢复和资源预算通过后，才进入对应发布门禁。
- 解析产物必须同时保留规范化 Markdown、结构化块/AST、页码或幻灯片/工作表定位、bbox/单元格范围、原始资产 URI 和质量告警。
- 文档创建、内容更新、重建请求、发布、废止和权限变更通过事务内 Outbox 事件触发对应工作：内容事件构建候选投影；发布事件激活已经验证的 Release；废止、删除和 ACL 事件负责投影失效或安全过滤更新。每个消费者独立幂等、重试、DLQ 和重放。
- 只有已发布且必需投影可用的文档版本才进入默认检索范围。未来加入图谱投影时，它默认是非阻断增强通道，但阶段 1 不实现或模拟该投影。

### 6.3 Retrieval

```text
Query Normalize
  -> Authorization Filter
  -> BM25 ∥ Vector kNN ∥ Optional Graph/Structured
  -> Weighted RRF / Dedup
  -> Candidate Limit
  -> Reranker
  -> Evidence Gate
  -> Parent Chunk Expansion
  -> Context TopK
```

建议把 `recallBudget`、`candidateLimit`、`contextTopK` 作为知识库级配置，并允许按问题类型动态调整。用户摘要中的“召回 1024、精排 5”是候选默认值，不是固定协议。

### 6.4 Answer/Citation

- 生成前给上下文证据分配稳定引用编号，要求模型输出结构化引用标记。
- 生成后按句切分，对漏标句执行 token/vector 相似度回填；逐句验证 Embedding 必须合并为一次批量调用，常规路径预算 P95 <= 600 ms，产出 `VERIFIED`/`WEAK`/`PENDING`，`WEAK` 必须在界面显式标注（见 ADR-0027）。
- 蕴含校验只用于高风险问答，附加一次 LLM 调用，路径预算 P95 <= 1.5 s，保留 2,048 output tokens 的发送前缓冲；验证失败返回 `EVIDENCE_ONLY` 或 `REFUSED`。单次 5 元预算口径包含 Chat、查询 Embedding、逐句验证 Embedding 与蕴含调用之和。
- 对候选引用执行权限、版本和有效期校验；冲突按 ADR-0033 的全序键确定性消解，同权威同范围的不相容证据判为 `CONFLICT` 并同时展示两条来源，不由模型择一。含未解决 `CONFLICT` 的运行不得由 `AnswerFinalizer` 提交为 `ANSWERED`，只能进入 `PARTIAL`、`EVIDENCE_ONLY` 或 `REFUSED`。
- 无据句默认标记为“不确定”或删除；高风险问题可整答拒绝。
- 保存 `answer_sentence`、`evidence_id`、`match_method`、`score`、`verification_status` 和模型版本，均不含摘录文本。
- 云模型使用 OpenAI-compatible HTTP Adapter；Chat、Embedding、Rerank 和引用验证保持独立的内部方法，并由环境配置具体模型。浏览器不得直接持有或调用模型 API Key。

### 6.5 图谱与结构化检索边界

- Neo4j 不进入 MVP 默认 Compose；只预留 `GraphProjectionAdapter` 和图谱证据协议。
- 实体/关系必须绑定 `document_version_id`、`chunk_id`、有效期、抽取版本、置信度和审核状态。
- 图谱查询与关键词/向量检索共享同一 `RetrievalScope`，先过滤租户、工作台、ACL 和有效期，再做多跳查询。
- 图谱证据必须回到原文 chunk 进行引用和蕴含校验；无原文证据的关系只能作为候选，不可直接进入回答。

### 6.6 客服知识治理不变量

- 首期回答只供客服人员内部使用，可以一键复制回复草稿，但不得自动发送给终端客户。
- 正式产品知识定义事实，标准话术定义表达，工单知识提供经验；三者冲突时按 `authority_level`（`OFFICIAL` > `STANDARD_SCRIPT` > `TICKET_DERIVED`）、适用范围精确匹配数、`valid_from` 新鲜度、版本创建时间、`documentVersionId` 字典序构成的全序键消解，并展示冲突提示。排序必须是全序，结果不得依赖知识空间的遍历顺序（见 ADR-0033）。
- 原始工单先脱敏、聚类和人工审核，再形成可广泛检索的工单知识；原始工单只能在授权的具体客户或具体工单场景中检索。
- 产品、版本、地区和生效时间是检索过滤字段，不是仅供展示的标签。缺少必要范围信息时，应先追问或返回多个明确标注的适用版本。
- 客服主管或产品专家是知识责任人；平台研发负责系统可用性和指标，不替代业务人员确认标准答案。
- 每个工作台维护独立黄金集和发布门禁，不能用客服集的平均分证明研发或员工场景质量。

### 6.7 客户上下文最小化

- 客服从当前工单进入助手时，只传递回答所需的产品、版本、地区、问题摘要和受控业务标识。
- 客户姓名、电话、地址、完整对话、订单支付信息等字段默认不进入 Prompt、长期记忆、Trace 和黄金集。
- 客户上下文只在当前回答 Run 的授权范围内有效；跨会话复用必须有独立业务依据和保留期限。
- 如果缺失产品、版本、地区或生效时间，助手应追问或明确列出不同适用条件，不能猜测客户范围。

## 7. 核心数据模型

### 7.1 PostgreSQL 表

```text
tenant
organization / department / user / role / user_role
knowledge_space / knowledge_member
document / document_version / document_asset
document_review / review_history
document_acl / acl_subject / acl_policy / legal_hold
deletion_request / deletion_target
source_connection / source_document_key / source_sync_run / source_cursor
ingestion_job / ingestion_step / step_attempt / projection_run / outbox_event / dead_letter
index_release / index_release_member / index_activation_intent / retrieval_policy_version / answer_policy_version
parser_version / chunking_policy_version / index_schema_version
model_version / prompt_version / model_route_version
chat_session / chat_message / answer_run / answer_run_event
answer_sentence / citation / citation_verification
evaluation_case / evaluation_run / evaluation_metric
audit_event
```

上述关系模型由 Prisma Schema 管理。需要 `CREATE EXTENSION`、部分索引、表达式索引、触发器或 Prisma 无法表达的约束时，在 Prisma migration 中加入显式 SQL；禁止为少量特殊 SQL 再并行引入第二套 ORM。

### 7.2 正交状态模型

四态审核状态本身足够，不能继续向其中加入解析失败、索引中、软删除等技术状态。企业级基座需要把不同事实拆成正交状态机；每个状态只回答一个问题：

```text
业务审核：       Draft --submit--> PendingReview --approve--> Published --archive--> Archived
                   ^                    |
                   +------ reject ------+

候选索引：       Draft/PendingReview --build--> Candidate Release --validate--> READY
                                                            |
业务发布：       Published + READY Release --activate--> ACTIVE Alias
                                                            |
失败回退：       smoke check failed -----------------> previous ACTIVE Release
```

| 状态轴 | 建议状态 | 回答的问题 |
|---|---|---|
| `DocumentReviewStatus` | `DRAFT / PENDING_REVIEW / PUBLISHED / ARCHIVED` | 该版本是否经过业务审核并允许对外服务 |
| `AssetStatus` | `STAGED / VERIFYING / AVAILABLE / QUARANTINED / REJECTED / CORRUPTED` | 原文件是否完成哈希、类型、安全扫描和完整性检查；删除由独立状态轴表达 |
| `IngestionJobStatus` | `QUEUED / RUNNING / SUCCEEDED / PARTIALLY_SUCCEEDED / FAILED / CANCELED` | 本次完整入库编排是否结束以及结果如何 |
| `IngestionStepStatus` | `PENDING / RUNNING / SUCCEEDED / FAILED / SKIPPED / CANCELED` | 某个可重试步骤当前处于什么状态 |
| `ProjectionStatus` | `PENDING / BUILDING / READY / FAILED / STALE / REMOVING / REMOVED` | 阶段 1 的关键词或向量投影是否可用于候选发布；未来图谱投影使用新增的独立状态轴 |
| `IndexReleaseStatus` | `CREATED / BUILDING / VALIDATING / READY / ACTIVE / SUPERSEDED / ROLLING_BACK / FAILED / ABORTED` | 一组索引是否经过校验、是否正在在线服务或回滚 |
| `DeletionStatus` | `ACTIVE / SOFT_DELETED / PURGE_PENDING / PURGING / PURGED` | 业务记录和各存储副本处于哪个删除阶段 |
| `OutboxEventStatus` | `PENDING / PUBLISHED / FAILED / EXHAUSTED` | 事务事件是否已经可靠投递给队列 |
| `DeadLetterStatus` | `OPEN / REPLAYING / RESOLVED / DISCARDED` | 失败任务是否已经被人工处理或重放 |
| `QuickParseStatus` | `UPLOADING / PARSING / READY / FAILED / EXPIRED / DELETING / DELETED` | 临时资料是否仍可在会话内使用 |
| `AnswerRunStatus` | `QUEUED / RUNNING / COMPLETED / FAILED / CANCELED` | 一次问答运行是否结束 |
| `EvaluationRunStatus` | `QUEUED / RUNNING / COMPLETED / FAILED / CANCELED` | 一次评测运行是否结束 |

问答过程不要把 `RETRIEVING / GENERATING / VERIFYING` 和 `REFUSED / DEGRADED` 混入 `AnswerRunStatus`：

- `phase` 表示当前阶段：`AUTHORIZING / RETRIEVING / RERANKING / GENERATING / VERIFYING / FINALIZING`。
- `outcome` 表示业务结果：`ANSWERED / REFUSED / PARTIAL / EVIDENCE_ONLY / UNAVAILABLE`。
- 运行状态、当前阶段和最终结果分开后，后续增加 Agentic Retrieval 或工具调用不会破坏既有状态机。

连接器进入后续版本时，新增独立的 `ConnectorSyncRun`，使用 `QUEUED / RUNNING / SUCCEEDED / PARTIALLY_SUCCEEDED / FAILED / CANCELED`，并保存 cursor、source event ID 和删除同步水位；不把同步状态塞进 `document_version`。

`legal_hold` 也不是删除状态。它是阻止进入 `PURGE_PENDING` 的合规约束，应单独保存施加人、原因、生效和解除时间。删除必须有 `deletion_request` 和按 PostgreSQL、OpenSearch、MinIO、Redis 等目标拆分的 `deletion_target`，否则无法证明每个副本都已完成删除或保留。

`OutboxEventStatus` 和 `DeadLetterStatus` 也不应塞入 `IngestionJobStatus`，否则无法区分业务任务失败和事件尚未投递。`index_activation_intent` 保存跨 PostgreSQL/OpenSearch 发布的意图、候选 Alias、上一 Alias、操作尝试和对账结果；它是可恢复协议的一部分。`answer_run_event` 按 `run_id + seq` 持久化事件元数据——`event_type`、`phase`、`occurred_at`、涉及的 `citation_id` 与 `document_version_id` 以及载荷哈希——不保存回答正文、证据摘录和模型原始思考链。正文与摘录增量写入 Redis 续读窗 `run:{runId}:events`（TTL 24 小时），长期唯一正文副本是对象存储中的 AnswerRun 最终快照；`answer_sentence` 与 `citation` 同样只保存句序号、绑定关系、匹配方式、验证状态、位置引用和哈希，界面展示摘录时按当前 ACL 从原文或快照实时取（见 ADR-0030）。这样删除时正文只需清理对象存储快照与 Redis 前缀两处，PostgreSQL 侧无正文可恢复。

### 7.3 可检索条件

`searchable` 是派生事实，不是允许任意接口直接修改的布尔字段。一个文档版本进入默认检索范围必须同时满足：

```text
review_status == PUBLISHED
AND asset_status == AVAILABLE
AND deletion_status == ACTIVE
AND effective_from <= now < effective_to（如果存在）
AND required projections == READY
AND this version is a member of the ACTIVE release for the requested scope
AND current user satisfies tenant/workspace/ACL/clearance policy
```

后台可以物化 `availability = NOT_READY / READY / DEGRADED / BLOCKED` 用于列表和告警，但它必须由上述事实计算，不能成为第二个事实源。关键词或向量等必需投影失败必须是 `BLOCKED`；未来的非必需增强投影失败可以产生 `DEGRADED`。

所有状态迁移遵循以下规则：

- 只允许通过领域命令迁移，例如 `submitReview`、`approveVersion`、`activateIndexRelease`、`requestPurge`，不提供通用 `PATCH status`。
- 使用版本号或 compare-and-set 防止审核、重试、取消和发布并发覆盖。
- 每次迁移记录前后状态、操作者/服务账号、原因、时间、Trace ID 和错误码。
- 重试创建新的 attempt 或步骤执行记录，不覆盖前一次失败证据。
- `projection_type`、`source_type` 等能力类型允许通过注册表扩展；生命周期状态使用受约束枚举，避免把任意字符串带进业务分支。

文档版本属于共享知识资产，但 `index_release` 必须带 `knowledge_space_id`、`index_partition_id` 和明确的检索作用域。不同工作台可以针对同一版本使用不同检索策略、模型和灰度策略；不能用一个无作用域的全局 Alias 假设所有工作台同时发布。

发布跨越 PostgreSQL 和 OpenSearch，不能声称存在跨库原子事务。采用“激活意图 + Alias 操作 + 对账修复”协议：

```text
PG transaction: create activation_intent + outbox event
        -> AliasSwitcher idempotently switches candidate alias
        -> Reconciler confirms alias + PG release membership
        -> mark ACTIVE, or mark ROLLING_BACK and restore previous alias
```

如果 Alias 已切换但 API 在写回 PostgreSQL 前崩溃，对账任务必须依据 `activation_intent` 继续完成或回滚；任何中间状态都不能让 API 返回“已发布”但检索不到版本。

索引只携带稳定的作用域键，不携带主体列表和 ACL 版本号。`acl_scope_key` 由 `tenant_id`、`knowledge_space_id`、`data_class`、`visibility_class` 组合而成，随文档版本一起投影，只在这些属性本身变化时才需要重投影。授权分两段：查询前由 PostgreSQL 编译出主体可见的作用域集合，写入 BM25 与向量过滤 `acl_scope_key IN allowedScopeKeys`；候选合并之后、融合与 Rerank 之前，对候选的 `document_version_id` 集合做一次批量 PostgreSQL 权威复核，校验文档级拒绝例外、删除墓碑、Legal Hold 和有效期。禁止逐候选查询 PostgreSQL。PostgreSQL 不可用或复核超时时整个查询 fail closed，返回证据不可用，不退化为只信任索引过滤。阶段 1 授权模型为纯作用域型；逐文档正向授权是加法、只能进预过滤，作为已识别扩展点预留但不实现，预过滤编译须保留可追加 `OR document_version_id IN (...)` 子句的形状（见 ADR-0026、ADR-0036）。

### 7.4 OpenSearch 文档字段

```json
{
  "chunk_id": "stable-id",
  "document_version_id": "version-id",
  "tenant_id": "tenant-id",
  "knowledge_space_id": "space-id",
  "content": "normalized text",
  "content_vector": "1024-dimension vector",
  "section_path": ["章", "节"],
  "page": 3,
  "bbox": [0, 0, 100, 100],
  "parent_chunk_id": "parent-id",
  "acl_scope_key": "tenant-id|space-id|INTERNAL|CONTROLLED",
  "data_class": "INTERNAL",
  "visibility_class": "CONTROLLED",
  "authority_level": "OFFICIAL",
  "clearance_level": 2,
  "valid_from": "2026-01-01T00:00:00Z",
  "valid_to": null,
  "parser_version": "deepdoc-v1",
  "chunking_version": "chunk-v1",
  "embedding_version": "gte-v1",
  "index_partition_id": "partition-id",
  "index_release_id": "release-id",
  "injection_risk": "none",
  "availability": "READY"
}
```

作用域字段只用于检索预过滤，最终权限判断以 PostgreSQL 的批量权威复核为准。`authority_level` 用于跨知识空间冲突的确定性消解（见 ADR-0033），`injection_risk` 用于不可信内容处置（见 ADR-0032）。索引发布采用新索引 + alias 原子切换，保留上一版本用于回滚；`index_partition_id` 的唯一键包含 `embedding_version`，换模型或改维度产生新分区而不是原地重写（见 ADR-0028）。

### 7.5 引用协议

```ts
export interface EvidenceRef {
  evidenceId: string;
  documentVersionId: string;
  chunkId: string;
  title: string;
  excerpt: string;
  location: {
    page?: number;
    bbox?: [number, number, number, number];
    startMs?: number;
    endMs?: number;
  };
  score: number;
  matchMethod: "explicit" | "vector" | "token" | "entailment";
  verificationStatus: "pending" | "verified" | "weak" | "conflict" | "blocked" | "expired";
  citationScope: "PERSISTENT" | "TEMPORARY";
}
```

## 8. 关键接口设计

### 8.1 文档接口

```text
POST   /api/v1/knowledge-spaces/:spaceId/documents/presign
POST   /api/v1/knowledge-spaces/:spaceId/documents/complete
GET    /api/v1/documents/:documentId
POST   /api/v1/documents/:documentId/submit-review
POST   /api/v1/documents/:documentId/publish
POST   /api/v1/documents/:documentId/rebuild-index
POST   /api/v1/documents/:documentId/retire
GET    /api/v1/ingestion-jobs/:jobId
POST   /api/v1/ingestion-jobs/:jobId/retry
POST   /api/v1/knowledge-spaces/:spaceId/rebuild
GET    /api/v1/knowledge-spaces/:spaceId/rebuild/:rebuildId
```

上传使用预签名 URL，API 不承载大文件内容。`presign` 创建有过期时间的 `upload_session`；`complete` 按 `uploadSessionId + idempotencyKey` 幂等校验临时对象，完成正式 Key 的认领和 PostgreSQL 事务后，才创建入库任务。重复 `complete` 返回既有文档版本或明确的失败状态，不重复创建对象认领和入库副作用。

`/documents/:documentId/rebuild-index` 只重建单个文档版本的投影。知识空间级别的索引重建走 `/knowledge-spaces/:spaceId/rebuild`：请求体指定目标 `indexSchemaVersion` 与 `embeddingVersion`，系统在新 `IndexPartition` 内以对象存储中的不可变 `ParseArtifact` 和 PostgreSQL 的 `chunk_manifest` 为数据来源重建，不重新解析原文件；通过数量、哈希、作用域和抽样检索校验后按 `IndexActivationIntent` 原子切换 Alias，旧分区保留为回滚目标直到显式回收。重建前重新校验删除墓碑、Legal Hold 和有效期，模型调用走同一预算闸门，预算不足时暂停且可恢复（见 ADR-0028、ADR-0029）。阶段 1 不提供自动全量重嵌入调度、双写影子对比和灰度 Alias 分流。

### 8.2 问答接口

```text
POST   /api/v1/chat/runs                 创建问答并返回 runId
GET    /api/v1/chat/runs/:runId/stream   SSE 流
POST   /api/v1/chat/runs/:runId/stop    停止生成
GET    /api/v1/chat/runs/:runId         查询最终快照
POST   /api/v1/chat/runs/:runId/feedback 反馈引用或答案质量
POST   /api/v1/quick-parse               临时文件解析
DELETE /api/v1/quick-parse/:sessionId    删除临时资料
```

问答请求至少包含 `knowledgeSpaceIds`、问题、会话 ID、回答模式和客户端请求幂等键。服务端从 Token 获取租户和用户，不接受客户端自报 `tenantId` 作为授权依据。

问答最终快照和可恢复事件使用稳定契约：

```ts
type AnswerRunStatus = "queued" | "running" | "completed" | "failed" | "canceled";
type AnswerPhase =
  | "authorizing" | "retrieving" | "reranking" | "generating"
  | "verifying" | "finalizing";
type AnswerOutcome = "answered" | "refused" | "partial" | "evidence_only" | "unavailable";

interface AnswerRunSnapshot {
  runId: string;
  status: AnswerRunStatus;
  phase: AnswerPhase;
  outcome?: AnswerOutcome;
  lastEventSeq: number;
  answer?: Answer;
  degradationReason?: string;
}
```

SSE 只传可展示进度、证据摘要、正文增量和最终结果；客户端断线后使用 `lastEventSeq` 续读，或者通过快照接口恢复，不依赖浏览器内存中的临时状态。

### 8.3 管理和评测接口

```text
GET/POST /api/v1/evaluations/cases
POST     /api/v1/evaluations/runs
GET      /api/v1/evaluations/runs/:runId
GET      /api/v1/audit-events
POST     /api/v1/index-releases/:releaseId/activate
POST     /api/v1/index-releases/:releaseId/rollback
```

## 9. 异步入库时序

```text
1. Web 从 API 获取仅指向临时前缀的预签名 URL，并直接上传 MinIO
2. API complete 校验 upload_session、哈希、大小、MIME、租户和文件状态
3. ObjectStorageAdapter 将通过校验的临时对象复制到内容寻址的正式 Key并复核目标哈希
4. DocumentModule 在同一 PostgreSQL 事务中写入 object_claim + document_version + outbox_event
5. Outbox Relay 使用 Publisher Confirm 发布 RabbitMQ 消息，确认成功后记录事件投递状态
6. ParserWorker 调用 DeepDOC/Office Adapter，产出 Markdown/AST/定位信息/质量告警，并对文本块执行注入静态扫描
7. ChunkWorker 按冻结的 ChunkingManifest 分块并生成稳定 chunk_id
8. 创建候选 index_release，SearchProjectionWorker 写入文档级和 Chunk 级关键词投影
9. EmbeddingWorker 批量生成向量，VectorProjectionWorker 写入候选向量投影
10. ReleaseValidator 校验数量、哈希、作用域键、抽样检索、引用定位和质量门禁，将候选 Release 标记为 READY
11. 知识责任人审核通过后执行 publish 命令；命令校验 Review、Asset、Projection 和 Release 状态
12. 激活 document_version，并原子切换知识空间的检索 Alias；上一 Release 进入 SUPERSEDED 但暂时保留。激活、回滚和索引重建前必须重新校验当前删除墓碑、Legal Hold、作用域、文档级拒绝例外和文档有效期；包含已删除或正在清理文档的 Release 不得激活。
13. 发布后 smoke check 失败则自动切回上一项仍合法的 Release，并把当前 Release 标记为 FAILED 或 ABORTED；若上一 Release 已包含删除目标，只能先构建过滤后的新 Release，不能直接恢复旧 Alias。
```

任何步骤失败都写入 `ingestion_step`，并根据错误类型决定重试、降级解析或 DLQ。发布前不能把“解析成功”误认为“已经可检索”，也不能让 `Published` 版本等待第一次索引构建。旧版本只有在新版本成功激活后才退出默认检索。

### 9.1 工单知识生成流程

```text
MVP：脱敏/合成工单 JSON 或 CSV 导入
未来：工单增量拉取 + Webhook 通知
  -> 原始工单受控存储
  -> PII/敏感字段识别与脱敏
  -> 问题聚类与候选知识生成
  -> 客服主管/产品专家审核
  -> 发布为工单知识版本
  -> 进入索引和客服黄金集候选池
```

当前不存在工单系统，因此 MVP 不实现 Webhook 和 API 增量同步。未来接入真实工单系统时，Webhook 只负责低延迟通知，增量拉取负责断线补偿和一致性校验；所有外部事件使用来源事件 ID 幂等消费，并设置游标、重放窗口和死信处理。

## 10. 问答数据流

```text
1. API 校验 Token、租户、用户级配额（并发 AnswerRun/SSE、QPS、日限）和请求幂等键
2. Query Orchestrator 做问题归一化和意图分类
3. AuthorizationModule 从 PostgreSQL 编译作用域集合，生成 RetrievalScope（阶段 1 纯作用域型；逐文档正向授权预留不实现）
4. RetrievalModule 并行执行 BM25 和向量召回
5. 候选合并后对候选集做一次批量 PostgreSQL 权威复核，越权、墓碑、Hold 和过期候选在此淘汰
6. Fusion/Reranker/EvidenceGate 形成证据包，冲突按全序键消解，注入命中候选不进入生成上下文；含未解决冲突的事实句不得由 AnswerFinalizer 提交为 ANSWERED
7. AnswerModule 注入引用约束并调用内部 ModelAdapter（预算预扣在 ModelAdapter 准入层完成），产出候选答案
8. CitationModule 逐句校验、补引、标记无据句并产出修订候选；高风险追加一次蕴含调用
9. AnswerFinalizer 按风险策略提交最终 AnswerRun 快照和最终事件；未通过验证的正文只能作为草稿事件
10. SSE 推送进度、证据、草稿和最终结果；正文增量写 Redis 续读窗，最终快照写对象存储
11. 状态迁移、授权、发布、删除等领域审计与业务事实同事务写入 PostgreSQL
12. TelemetryModule 将 Trace、Token、成本和高频运行遥测通过 Outbox 异步投递到观测/统计存储
```

## 11. 可靠性与安全设计

### 11.1 重试、熔断和降级

- 网络抖动：指数退避 + 抖动，限制最大次数。
- 模型超时：首包超时和整段超时分开设置。
- 模型不可用：主模型 → 备用模型 → 缓存/仅证据 → 明确不可用。
- 解析失败：回退到原生文本或 OCR；低置信度进入人工校对。
- OpenSearch 不可用：禁止无证据自由回答，返回可解释的服务降级状态。

### 11.2 安全边界

- 文件上传执行 MIME、大小、病毒、压缩炸弹和 SSRF 检查。
- 文档内容永远是数据，不是系统指令。检索内容以带来源标识的结构化块注入，使用固定定界符包裹，系统指令、工具定义与权限上下文永远排在资料之前。注入检测发生在三处：解析产物入库时的静态扫描（命中标记 `injection_risk = suspected`，整篇高密度命中则资产置 `QUARANTINED` 并阻断发布）、候选进入生成上下文前的运行时检查（覆盖 quick_parse 与静态扫描后的内容变化）、回答产出后的输出检查。`suspected` 候选只作证据展示、回答按 `EVIDENCE_ONLY` 处理，Top5 全部命中则 `REFUSED`，`blocked` 内容既不进上下文也不进证据。系统任何情况下都不跟随文档内 URL、不执行文档内代码、不因文档内容扩大工具白名单或权限范围；每次命中写领域审计（见 ADR-0032）。
- 用户级限流与并发配额：并发 AnswerRun 1、并发 SSE 2、提问 10 次/分钟与 200 次/日、上传 20 个/小时，管理侧 `rebuild` 每租户并发 1。提问/上传频次使用 Redis 软闸门；AnswerRun/SSE 同时受 API 本地 semaphore 与 PostgreSQL 用户并发 lease 约束，Redis 只用于跨进程快速拒绝和展示。超限返回 `429` 与 `Retry-After`；Redis 不可用时频次计数可以告警后放行，但不得关闭本地并发限制或数据库 lease，因为租户级预算硬闸门仍在 PostgreSQL（见 ADR-0034、ADR-0036）。这些默认值待 PROBE-005 与首轮评测校准。
- 所有外部模型调用带数据分级、脱敏和供应商策略；数据分级的强制执行点是 `ModelAdapter` 准入层，`UNKNOWN` 与敏感等级默认拒绝云调用且不进入降级链（见 ADR-0025）。
- 引用查看、原文下载、导出和分享链接都重新做权限判断。
- API Key、数据库密码、模型 Token 只进入 Secret 管理，不写 `.env.example` 真实值。
- 试点阶段仅使用脱敏样本，不接入包含真实敏感字段的客户数据；完成权限、审计、删除和安全专项验收后，才能单独审批真实数据接入。
- 当前没有本地 GPU，云端小模型只允许处理合成或严格脱敏的数据。若输入被标记为敏感，系统必须拒绝模型调用或只返回受控检索结果。

### 11.3 环境与部署

- 流程验证 MVP 默认使用 Docker Compose 启动 Keycloak、PostgreSQL、OpenSearch、Redis、RabbitMQ、MinIO、Next.js、NestJS 和必要 Worker；Neo4j、阿里云 OSS 不进入默认部署。
- 当前开发机为 32 GiB 主机内存，WSL2 日常上限建议 22 GiB，执行 DeepDOC 或批量评测时可临时提高到 24 GiB。MinIO 设置 512 MiB～1 GiB 内存上限，OpenSearch JVM 初始限制为 2 GiB；完整观测栈和压测任务分别按需启动，不把该规格当作本地模型或生产压测环境。
- 进入真实用户试点后再使用企业私有 Kubernetes，将在线 API、解析 Worker、Embedding/Reranker 和本地模型分开部署、配额和扩缩容。
- 敏感资料只能进入本地模型执行区；本地模型不可用时不得降级到云模型。
- 开发和试点使用独立 Realm、数据库、对象桶、索引前缀和密钥，不复制生产身份和敏感数据到开发环境。

## 12. 可观测性和验收指标

### 12.1 Trace 结构

```text
request
  -> auth
  -> authorization.scope-compile
  -> query-understanding
  -> retrieval.bm25
  -> retrieval.vector
  -> authorization.candidate-recheck
  -> fusion
  -> rerank
  -> llm.first-token
  -> citation.verify
  -> response
```

每个 Span 至少记录 `tenant_id`、`run_id`、版本号、候选数量、命中数量、耗时、Token、模型、降级原因和错误码。日志不得写入原始敏感正文。

Trace 的产生是应用内建能力而不是可选组件：`traceId`/`spanId` 由 NestJS 与 Worker 按 W3C `traceparent` 生成并贯穿 HTTP、SSE、Outbox 消息和领域审计，`traceId` 直接落在审计与事件记录上。完整观测后端（Collector、Prometheus、Grafana、Loki/Tempo）按需 Profile 启动，用于可视化和聚合查询；观测后端未启动时不影响 `traceId` 的产生与关联，因此"回答与任务可按 traceId 追溯"这条 P0 门禁不依赖常驻观测栈。

### 12.2 MVP 硬门禁与候选目标

| 领域 | 指标 | 说明 |
|---|---|---|
| 硬门禁：权限 | 越权证据泄漏 = 0 | 跨租户、跨部门、越密级专项测试 |
| 硬门禁：主链路 | 上传、解析、索引、检索、引用、拒答、审核和回滚可运行 | 每一步都有可观察状态和失败结果 |
| 硬门禁：引用 | 引用可点击回跳到授权原文位置 | 下载和预览时再次鉴权 |
| 硬门禁：拒答 | 无依据问题拒答或明确标记不确定 | 禁止为了完整性绑定弱相关证据 |
| 硬门禁：回归 | 50 道黄金题在固定版本上可重复运行 | 固定语料、索引、模型和配置版本 |
| 候选目标：检索 | Recall@5 0.92 | 得到真实基线后再决定是否升级为发布门禁 |
| 候选目标：引用 | 覆盖率 0.96，并另设正确率 | 覆盖率不能替代正确率 |
| 候选目标：忠实度 | 0.95 | 必须先统一事实句和蕴含评测口径 |
| 候选目标：性能 | P50 1.2s | 仅在固定黄金集和固定模型上报告；必须拆分检索、TTFT、生成、引用验证，不作为单一硬 SLO |

### 12.3 基座级测试矩阵

| 测试层 | 必测内容 | 防止的故障 |
|---|---|---|
| 领域单元测试 | 每个合法/非法状态迁移、可检索条件、知识权威顺序、拒答策略 | 大枚举非法组合、绕过审核或 ACL |
| 契约测试 | Parser、Model、ObjectStorage、Retrieval、事件 `schemaVersion` 当前/上一版本 | 替换供应商或升级 Worker 时协议漂移 |
| 集成测试 | PostgreSQL + RabbitMQ + Redis + MinIO + OpenSearch 的真实容器链路 | Mock 通过但事务、队列和索引行为不一致 |
| 幂等与并发测试 | 重复 complete/outbox/job、审核并发、重试与取消、ACL 变更竞态 | 重复索引、状态倒退、越权窗口 |
| 故障注入 | Parser 崩溃、Embedding 超时、Redis 重启、Alias 已切但 PG 未确认 | 卡死任务、发布状态分裂、无法回滚 |
| 安全测试 | 跨租户/工作台/密级、恶意文件、Prompt Injection、预签名 URL 越权 | 数据泄漏和不可信内容控制失效 |
| RAG 评测 | 检索、重排、引用覆盖/正确率、忠实度、拒答、冲突和过期知识 | 只优化流畅度或平均分掩盖长尾错误 |
| 恢复演练 | 数据库恢复、对象完整性、索引重建、DLQ 重放、上一 Release 回滚 | 备份存在但实际无法恢复服务 |

状态机测试采用表驱动用例；索引发布至少覆盖以下失败窗口：

```text
candidate built -> validation failed
validation passed -> review rejected
activation intent committed -> alias switch failed
alias switched -> PG acknowledgement lost
new release active -> smoke check failed -> previous release restored
ACL revision changed while retrieval is in flight -> stale candidate rejected
```

## 13. 分阶段落地

### 阶段 1：企业级基础 MVP

- `apps/web` + `apps/api` + `apps/worker`；Worker 以 `ingestion`、`evaluation` 两个 Profile 独立运行。
- PostgreSQL、OpenSearch、Redis、RabbitMQ、MinIO、OIDC；阿里云 OSS 仅保留未来部署适配，不进入 MVP。
- 首批格式的 PDF/OCR/Markdown/JSON/CSV、BM25 + 向量 + Reranker；分块参数由 PROBE-006 实测后冻结为 `ChunkingManifest` 默认值，不在探针前写死（见 ADR-0031）；Office 格式先做探针，按通过结果逐项纳入。
- 引用协议、SSE、原文回跳、基础审计和 Trace。
- 正交状态机、候选 Release、发布校验、Alias 对账、回滚和删除清理闭环。
- Parser/Model/ObjectStorage/MessageBus 契约测试，RetrievalChannel/FusionRerankPolicy 行为测试，真实中间件集成测试和关键失败窗口故障注入。
- 独立客服 Web 工作台、回复草稿复制、知识审核流程。
- 人工编写产品资料、标准话术、脱敏/合成工单和黄金题，验证三类知识的权威顺序。
- 工单通过 JSON/CSV 文件导入，不建设工单管理系统，也不实现不存在的上游 Webhook/API。
- 通过阿里云百炼的 OpenAI-compatible Adapter 使用云端小模型处理合成或严格脱敏数据，先跑通检索、引用、拒答和反馈流程；首月模型预算上限 500 元，超过后停止评测任务。
- Docker Compose 默认启动 PostgreSQL、OpenSearch、RabbitMQ、Redis、Keycloak 和 MinIO；Parser 和完整观测栈通过独立 Profile 按需启动，阿里云 OSS 不进入 MVP 部署。
- `worker:ingestion` 与 `worker:evaluation` 使用独立进程、队列、并发和预算池；初始硬上限为 ingestion 并发 4/in-flight 8、evaluation 并发 1/in-flight 1、Parser 并发 1、OpenSearch fan-out 2 个 KnowledgeSpace、候选 1024、请求总超时 250 ms、ACL 候选复核 60 ms、引用验证常规 600 ms/高风险 1.5 s、高风险输出缓冲 2,048 tokens。模型调用前在 PostgreSQL `model_budget_ledger` 内预扣并取 lease，单次 <= 5 元、每日 <= 16 元、月度 <= 500 元（16 × 31 = 496，三个上限自洽）；超限只允许排队、降级、evidence-only 或拒答。
- 使用一个虚构的企业客服工单 SaaS 构建互相关联的产品资料、套餐/版本/地区规则、账号、权限、退款、API、错误码、故障处理、标准话术、合成工单和黄金问题。
- 首批发布门禁支持 Markdown、原生/扫描 PDF 和 JSON/CSV 工单；Parser Service 包装固定版本 RAGFlow DeepDOC。DOCX/PPTX/XLSX 通过专用 Adapter 统一产出 Markdown/AST，并在探针通过后逐项加入阶段 1 门禁。
- pnpm workspace 管理 Next.js、NestJS、Node Worker、共享契约、Prisma 和 Python Parser Service。
- 初始知识种子集约 30 份产品资料、100 条合成工单、10 条标准话术和 50 道人工可检查的黄金题。
- 首期语言为简体中文，允许英文产品名、错误码和技术术语，不建设跨语言检索。
- 计划周期采用 24～36 周弹性窗口，六个架构探针完成后基于身份链路、资源、解析质量、模型延迟和逐片 DoD 重新估算；每个切片都必须包含状态、审计、失败路径、测试和恢复验证。

### 阶段 2：企业增强

- 完整 ABAC 策略设计器、外部权限同步和可解释授权运营界面。
- DeepDOC 解析校对台、复杂表格/图表人工修订和批量质量运营。
- 高级反馈运营、知识缺口、A/B 实验管理和黄金集自动扩充。
- 高级多模型路由、租户级策略、私有模型执行区和容量调度。
- 在客服工作台稳定后接入研发和普通员工工作台，并分别建设连接器与黄金集。
- 接入真实工单系统的 Webhook + API 增量同步，建设本地模型执行区，并进入私有 Kubernetes 试点。

### 阶段 3：行业智能

- GraphRAG/RAPTOR、SQL/API 只读工具、Agentic Retrieval。
- 音视频时间点引用、图文跨模态检索。
- 主动学习、漂移检测、跨地域灾备和行业合规模板。

## 14. 关键决策与实现前置事实

### 已确定的技术原则

1. TypeScript 负责产品控制面和编排，不替代 Python/模型运行时。
2. 首期使用 PostgreSQL + OpenSearch + Redis + MinIO；对象存储位于可替换 Adapter 后，阿里云 OSS 延后到未来云端部署。
3. 权限过滤必须在召回前进入每路检索器。
4. 采用“生成前引用约束 + 生成后句级校验 + 无据句处理”。
5. Next.js 和 NestJS 保持两个应用，但 NestJS 控制面先做模块化单体；解析和模型按资源特征独立运行。

### 已采用的试点假设

- 产品形态为单企业试点，数据模型保留未来多租户演进能力。
- 当前目标是由一名资深前端配合 AI 边写边学，完成可重复验证的流程 MVP；真实用户试点是下一阶段。
- 首期完整交付客服工作台；研发和普通员工工作台保留共享协议与扩展 seam，后续分别接入代码仓库、制度流程和专属知识源。
- 客服只看到内部证据回答和可复制的回复草稿，系统不自动向终端客户发送消息。
- 当前只允许云模型处理合成或严格脱敏数据；敏感资料仍只能路由到未来的本地模型执行区。
- 客服知识默认按产品、版本、地区和生效时间过滤；知识冲突按 `authority_level` 全序键确定性消解，同权威同范围的不相容证据判为 `CONFLICT` 并展示两条来源。
- 原始工单必须脱敏、聚类、审核后才能形成通用工单知识。
- 项目从零建设身份系统，开发和试点统一使用 Keycloak + OIDC；未来接入企业 LDAP/SSO 时保留 OIDC 接口，不改业务用户和 ACL 模型。
- 当前不存在工单系统，MVP 只导入脱敏/合成工单文件；未来接入时采用 Webhook 通知 + API 增量拉取补偿。
- 研发工作台首期只保留协议和数据字段，不接入 Git 仓库。
- 流程 MVP 使用 Docker Compose；真实用户试点再部署企业私有 Kubernetes。
- MVP 只使用合成或严格脱敏样本，暂不接入包含敏感字段的真实客户数据。
- 100 名客服、日问答 5,000、峰值并发 30、10 万文档/500 GB 等数据仅作为未来试点容量假设，不作为 MVP 交付门禁。
- 一个用户可以加入多个工作台并拥有不同工作台角色；文档版本作为共享知识资产由工作台按权限绑定。
- MVP 就接入 Keycloak 单 Realm 和管理员创建用户流程，不自研账号密码系统。
- PostgreSQL、OpenSearch、Redis、RabbitMQ、Keycloak 和 MinIO 进入默认 Compose 主链路；Neo4j、阿里云 OSS 不部署，仅保留未来适配方案。
- 文档审核采用 Draft、PendingReview、Published、Archived 四态；处理状态独立于审核状态。
- 新版本在 Draft/PendingReview 阶段通过 Outbox + RabbitMQ 构建候选关键词和向量索引；审核通过后激活已校验 Release。图谱只保留未来协议，不创建阶段 1 图谱任务或表。投影任务支持幂等、重试、DLQ、重放和 Alias 对账回滚。
- Neo4j 仅作为未来多跳场景的可选证据通道，MVP 不启动。
- Chat、Embedding、Reranker 和引用验证模型使用阿里云百炼云 API，但全部位于可替换的 Model Adapter 后；首月预算上限 500 元。
- 知识种子集采用虚构的企业客服工单 SaaS，项目先完成可演示 MVP，再根据结果决定开源或商业化方向。
- MVP 页面覆盖登录、客服问答、知识上传/列表/详情、入库任务、知识审核、用户权限和黄金集评测。
- PostgreSQL 使用 Prisma + Prisma Migrate；特殊数据库能力使用自定义 SQL migration，不引入第二套 ORM。
- 模型通过 OpenAI-compatible Adapter 接入，不绑定供应商 SDK。
- 首批发布门禁格式限定为 Markdown、原生/扫描 PDF 和 JSON/CSV 工单；DOCX/PPTX/XLSX 只有在专项探针通过后逐项纳入；首期语言为中文为主。
- 初始种子集为约 30 份产品资料、100 条合成工单、10 条标准话术和 50 道人工可检查的黄金题；扩展到 200 题后再作为分层回归基线，不把题量增长误认为架构升级。

### 实现前置事实

产品定位、首期角色、技术基线、参考仓库复用方式和阶段边界已经在项目主事实源与 ADR 中确认。实现前仍需通过六个架构探针实测以下事实：Keycloak 初始化、OIDC Code + PKCE、Token 校验、用户映射、会话过期和撤权链路；OpenSearch Alias/作用域过滤与 kNN 参数选型；RabbitMQ 重试/DLQ/重放；百炼 ModelAdapter 的延迟/费用/错误映射与预算账本；首批 Parser 格式的资源和定位质量；分块参数对 Recall@5 与引用可定位率的影响。探针结果应写入工程评审闭合记录，不再通过聊天重新定义架构方向。

下一步产物顺序固定为：Prisma schema 与状态命令、RabbitMQ 事件/队列契约、Parser/Model/ObjectStorage Adapter 契约、OpenAPI、前端页面路由和 Docker Compose Profile。
