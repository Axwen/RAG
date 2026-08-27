# 设计：企业级可信 RAG 基础 MVP 产品与架构边界

> 生成日期：2026-08-21  
> 工作流：`office-hours`  
> 状态：工程评审已闭合，待架构探针与实现验证  
> 模式：Builder  
> 事实源级别：项目内主事实源  
> 适用阶段：阶段 1，企业级基础 MVP  
> 后续评审：`plan-eng-review`

## 1. 文档地位与维护规则

本文固化已经确认的产品目标、范围边界、架构原则、交付方式和验收标准，防止后续会话、设计稿和实现之间发生决策漂移。

事实源优先级如下：

1. 本文记录产品与阶段边界，以及跨模块架构决策的当前结论。
2. `docs/adr/` 记录单项技术决策及其理由；若 ADR 与本文冲突，必须通过新增 ADR 显式取代旧决策，并同步修改本文。
3. `技术设计方案-TS企业级多模态RAG.md` 记录完整技术设计细节。
4. `企业级可信多模态RAG知识库功能报告.md` 记录功能全景、参考实现和市场方向。
5. gstack 目录中的副本只用于跨会话发现，不是可独立修改的第二事实源。

任何后续变更若影响公开 API、持久化模型、权限边界、Manifest、状态机、消息协议、删除协议或阶段 1 DoD，必须先更新本文或新增 ADR，不能只修改代码或聊天结论。

## 2. 产品结论

阶段 1 交付一个面向客服人员的可信知识助手，而不是通用企业知识库，也不是只有向量检索和聊天页面的 RAG Demo。

产品用可授权的正式产品资料、标准话术和经过脱敏、审核的工单知识，为客服生成可复制的回复草稿。事实性结论必须能回到当前用户有权访问的不可变原文版本。系统不自动向终端客户发送消息。

研发和普通员工未来共用同一基座，但阶段 1 不完整交付它们的工作台、连接器和黄金集。它们通过新增工作台配置、数据源 Adapter、检索策略和领域模块扩展，不复制后端，也不创建独立 Git 分支产品。

## 3. 最窄可交付业务闭环

阶段 1 的首条完整纵向链路固定为：

```text
客服知识上传
  -> 文件安全检查与不可变资产登记
  -> 文档审核
  -> 异步解析、分块、Embedding 与索引投影
  -> 候选 Release 校验与激活
  -> 客服带受控上下文提问
  -> ACL 前置的 BM25 + 向量混合检索
  -> 融合与 Reranker
  -> 证据闸门与风险分级生成
  -> 句级引用校验、原文回跳或拒答
  -> 客服复制回复草稿
  -> 反馈、客服结果指标与黄金集回归
```

这条链必须使用正式中间件、正式状态、正式消息协议、审计和测试。不得先建设一条内存队列、临时文件或 Mock 主链，再计划以后替换。

## 4. 用户与知识边界

### 4.1 首期用户

- 主要使用者：客服人员。
- 知识责任人：客服主管或产品专家，负责审核、纠错和失效处理。
- 平台管理员：管理用户、工作台、知识空间和运行状态。
- 终端客户：不直接使用本系统，也不会收到系统自动发送的消息。

### 4.2 首期知识源

- 正式产品资料。
- 已审核的标准话术。
- 合成或严格脱敏、经过审核的工单知识。
- Markdown、原生或扫描 PDF、DOCX、PPTX、XLSX。
- JSON/CSV 形式的合成或脱敏工单导入。

知识冲突默认按“正式产品知识 > 标准话术 > 工单知识”处理，同时必须考虑产品、版本、地区和生效时间。

### 4.3 种子数据

阶段 1 使用虚构的企业客服工单 SaaS 形成互相关联的种子集：

- 约 30 份产品资料。
- 约 100 条合成工单。
- 约 10 条标准话术。
- 50 道人工可检查的黄金题，数据成熟后分层扩充到 200 题。

题量不是质量本身。黄金题必须绑定身份、问题、期望行为、允许证据、禁止证据、文档版本和风险等级。

### 4.4 术语边界

- `Tenant`：数据、身份和策略的最高业务隔离域；阶段 1 只运行一个试点租户，但所有业务记录仍显式带租户作用域。
- `Workspace`：客服等角色使用的产品工作台，绑定知识空间、检索策略、回答策略和成员关系。
- `KnowledgeSpace`：具有独立成员、知识来源、生命周期和发布范围的一组知识资产。
- `IndexPartition`：由租户、知识空间、数据等级、索引 Schema 和 Embedding 版本共同决定的物理检索分区。
- `Candidate Release`：已经构建但尚未服务线上检索的不可变索引发布。
- `Active Release`：当前被检索 Alias 指向并允许服务请求的发布。
- `ACL 作用域键`：由租户、知识空间、数据等级和可见性等级组合成的稳定索引过滤键；索引只携带它，不携带主体列表或授权版本号。
- `ACL revision`：授权事实的单调版本；只用于失效 Redis 中的作用域缓存，不写入索引。
- `候选权威复核`：候选合并后对候选文档版本集合做的一次批量 PostgreSQL 授权校验，是最终授权判定点。
- `预算账本`：PostgreSQL 表 `model_budget_ledger`，模型调用的预扣、结算与 lease 回收都在其上完成；Redis 只缓存剩余额度用于展示和快速拒绝。
- `回答快照`：AnswerRun 完成时写入对象存储的不可变正文、逐句引用和证据摘录，是回答正文的唯一长期副本。
- `回滚`：恢复上一项仍合法的配置、Manifest 或 Release，不恢复已删除的数据。
- `恢复`：从部分失败或基础设施故障中重建服务状态；恢复必须继续遵守当前授权、保留和删除事实。
- `删除墓碑`：不含正文的最小审计记录，用于解释资源为何不可用并防止已删除副本重新出现。

## 5. 企业级基础 MVP 的含义

“基础 MVP”限制业务范围和首期数据源，不削弱正式产品边界。阶段 1 必须完成：

- Keycloak OIDC 登录、业务用户、工作台成员和文档 ACL。
- 不可变知识资产和文档版本。
- 审核、文件安全、入库、投影、发布、删除和问答的正交状态。
- PostgreSQL Outbox、RabbitMQ 至少一次投递、幂等、取消、重试、DLQ 和人工重放。
- 候选索引 Release、质量校验、Alias 激活、对账和上一版本回滚。
- ACL 前置的 BM25 + 向量混合检索、融合和 Reranker。
- 风险分级的句级引用、无据句处理、拒答、引用回跳和可恢复 SSE。
- 数据分级、外发策略、保留、Legal Hold、删除目标和删除证明。
- Trace、成本、客服结果指标、黄金集评测、发布门禁和恢复演练。

阶段 1 的完整性来自这些边界能够闭合，而不是功能数量最多。

## 6. 技术基线

### 6.1 应用与运行时

- Web：Next.js + React + TypeScript。
- API/BFF：NestJS + TypeScript，阶段 1 保持模块化单体。
- 异步执行：Node.js Worker。
- 复杂解析：独立 Python Parser Service。
- ORM：Prisma + Prisma Migrate；特殊 PostgreSQL 能力使用受控 SQL migration，不引入第二套 ORM。
- 模型接入：内部 `ModelAdapter`，通过 OpenAI-compatible HTTP（Chat Completions 或 Responses 二者之一）接入云侧 Chat、Embedding、Reranker 和高风险引用验证；供应商基线见 [ADR-0017](../adr/0017-mvp-cloud-model-and-budget.md)（Embedding = OpenRouter `qwen/qwen3-embedding-8b`；Chat = fluxionai `gpt-5.6-terra` · Responses；Reranker = OpenRouter `qwen/qwen3-reranker-8b` · Cohere 形状 `POST {base}/rerank`）。

阶段 1 不部署独立 Model Gateway 服务。模型调用先作为共享后端模块存在；只有出现多个独立应用、跨租户统一路由、独立扩缩容或统一网关治理需求时才拆分进程。

### 6.2 中间件

- PostgreSQL：业务事实、任务、Attempt、Outbox、Manifest、审计和删除事实源。
- OpenSearch：关键词、向量、过滤、聚合和版本化检索索引。
- RabbitMQ：异步任务投递，不保存业务最终状态。
- Redis：缓存、限流、短期会话、quick_parse TTL 和协调，不承担应用任务队列。
- MinIO：阶段 1 本地对象存储；未来通过 `ObjectStorageAdapter` 切换阿里云 OSS。
- Keycloak：身份认证、令牌和登录安全；业务权限仍由 PostgreSQL 领域数据决定。

阶段 1 默认只承诺 Markdown、原生 PDF、扫描 PDF 和 JSON/CSV 工单进入发布门禁。DOCX、PPTX、XLSX 先通过 Parser 探针验证统一 ParseArtifact；只有专项样本和失败行为通过后，才逐项纳入阶段 1 DoD，不能因为格式被列入产品方向就同时承诺完整质量。

### 6.3 本地运行方式

统一使用 Docker Compose Profile：

- `core`：PostgreSQL、OpenSearch、RabbitMQ、Redis、MinIO、Keycloak。
- `app`：Web、API、Outbox Relay、基础 Worker。
- `parser`：DeepDOC Parser Service。
- `observability/evaluation`：观测、评测和压测组件，按需启动。

32 GiB 主机中，WSL2 日常上限建议 22 GiB，解析或批量评测时可临时提高到 24 GiB。本地环境不承担本地大模型和生产容量验证。

## 7. 参考仓库复用策略

参考快照固定为：

- ragent：`16984b95454d3fc2a55b60ade1950fefeba339ec`
- RAGFlow：`618c4599b10e792a5eaf3dee9c1cbe7c741c4803`

采用“固定快照 + Adapter 包装 + 按稳定协议逐步自研”：

- RAGFlow DeepDOC 运行在独立 Parser Service 内，通过 `ParseInput -> ParseArtifact` 契约提供版面、OCR、表格和定位信息。
- 不复制 DeepDOC 单个文件，不把完整 RAGFlow 作为本项目业务后端，也不依赖其数据库和内部任务表。
- ragent 的多路检索预算、融合、证据闸门、模型健康和评测设计作为源码参考。阶段 1 只实现一条本项目检索主链；若架构探针需要对照，可使用仅限测试的内部 Harness，不把整条 `RetrievalAdapter` 定义为正式运行时插件边界，正式链路使用内部 `RetrievalChannel` 和融合策略。
- 本项目掌握身份权限、领域状态、Manifest、RabbitMQ 协议、索引发布、引用、数据生命周期和评测门禁。
- 引用策略吸收“生成前来源约束”和“生成后 token/vector 回填”，但必须增加权限复核、蕴含检查和无据句策略。

复用前必须完成固定版本打包、许可证、模型文件、依赖、资源占用、产物格式和失败行为核验。

## 8. 稳定外部边界

阶段 1 只为真正不稳定的外部系统建立正式 Adapter：

- `ParserAdapter`
- `ModelAdapter`
- `ObjectStorageAdapter`
- `MessageBus`

OpenSearch 客户端可以封装在检索模块内部，但不为了假设中的第二实现提前建设插件市场。分块、融合、重排和引用是内部策略模块，以版本化契约和测试保证可替换性，不为每一步建立通用注册框架。

## 9. Manifest 与不可变运行快照

以下方向已经确定，字段、唯一约束和兼容矩阵由工程评审最终闭合。

### 9.1 聚合式 Pipeline Manifest

为避免 parser、chunker、embedding、schema、retrieval、reranker、prompt 和模型版本自由组合导致笛卡尔积失控，使用批准后的聚合清单：

```text
IngestionManifest
  parser + chunker + embedding + index schema

RetrievalManifest
  retrieval channels + candidate budgets + fusion + reranker

AnswerManifest
  prompt + model route + citation + risk policy
```

三个聚合清单共同形成产品层可批准的 `PipelineManifest`，但它不是一个运行时必须整包激活的单体版本。Manifest 不可变，内容变化创建新版本，不原地修改。

冻结边界如下：

```text
PipelineManifest（产品批准组合）
  ├─ IngestionManifest ──> ReleaseManifest ──> 一个或多个物理索引
  ├─ RetrievalManifest ───────────────────────┐
  └─ AnswerManifest ──────────────────────────┼─> RetrievalSnapshot ─> AnswerRun
一个或多个 ReleaseManifest ──────────────────┘
```

- `ReleaseManifest` 只冻结入库和索引可复现性，不冻结工作台的检索、Prompt 或模型策略；它只引用 `ingestionManifestId`，不反向持有 `pipelineManifestId`。
- `RetrievalSnapshot` 冻结一次问答实际使用的 Release 集合、检索策略和回答策略，并记录兼容矩阵校验结果。
- `PipelineManifest` 用于批准兼容组合和发布门禁，运行时仍引用上述具体 Manifest ID；不允许绕开兼容矩阵自由拼装。
- `PipelineManifest` 是批准后的兼容组合，不是 `ReleaseManifest` 的父对象。一个 `RetrievalSnapshot` 可以包含多个知识空间的 Release，并记录本次共同使用的 `RetrievalManifest`、`AnswerManifest`、`approvedPipelineManifestIds[]` 和兼容校验哈希。跨空间查询不要求所有 Release 共享同一个 IngestionManifest，但必须存在共同通过的 Retrieval/Answer 兼容组合。
- 回滚索引只切换到上一项仍合法且兼容的既有 `ReleaseManifest`；回滚检索或回答策略只切换到上一项仍合法且兼容的既有 `RetrievalManifest` 或 `AnswerManifest`。如果内容需要修改，才创建新版本，历史 Manifest 不原地修改。

### 9.2 ReleaseManifest

`ReleaseManifest` 是一次候选索引构建的不可变事实，至少绑定：

- 租户和知识空间作用域。
- `IndexPartition`。
- `IngestionManifest`。
- 可验证的文档版本成员清单；大规模时可外置为内容寻址对象，但 `ReleaseManifest` 必须保存其 URI、哈希、数量和 Schema，不能只保存动态查询条件。
- 文档级索引和 Chunk 混合索引的物理标识。
- 候选 Alias、校验结果、创建时间、构建完成时间和上一 Release 候选引用。
- 内容哈希、Schema 版本和兼容性信息。

激活时间、当前 Alias 指向、激活尝试、对账结果和最终替代关系不写回 `ReleaseManifest`，由唯一的 `ReleaseActivation` 事实记录。`IndexActivationIntent` 只是该激活流程使用的幂等操作记录和 Outbox 载荷，不是第二套激活状态事实源。这样 Candidate、Active 和 Previous 的事实都保持可追溯，不通过修改不可变 Manifest 表达运行时状态。

工作台策略本身不应导致复制索引；只有数据作用域、索引 Schema 或入库产物改变时才生成新 Release。

### 9.3 RetrievalSnapshot

一个回答可以查询多个知识空间，因此 `AnswerRun` 固定的不是单一 `indexReleaseId`，而是不可变 `RetrievalSnapshot`：

- 本次使用的一个或多个 `ReleaseManifest`。
- `RetrievalManifest` 和 `AnswerManifest`。
- `approvedPipelineManifestIds[]` 与兼容矩阵校验哈希/结果。
- 查询时的授权主体、作用域摘要、`aclRevision`、复核前后的候选数量和冲突消解结果。
- 实际候选、排序、过滤和证据集合的内容寻址快照或不可变对象引用；Retention 到期或合规删除后降级为墓碑和指标元数据。
- 运行时间、Trace 和版本校验信息。

实时撤权优先于历史可复现。历史快照不能绕过当前预览、下载和引用展示授权。

## 10. 正交状态原则

以下状态轴独立保存，不创建一个包含所有含义的 `document_status`：

- 文档审核：`DRAFT / PENDING_REVIEW / PUBLISHED / ARCHIVED`。
- 文件安全与可用性。
- 入库 Job。
- 入库 Step。
- Step Attempt。
- 关键词和向量投影。
- 索引 Release 与激活意图。
- 删除请求、删除目标和 Legal Hold。
- quick_parse 生命周期和重放等级。
- AnswerRun 运行状态、当前阶段和最终结果。
- Outbox 投递和 Dead Letter 处置状态。

`searchable` 是派生事实，不是可直接写入的业务字段。所有迁移必须经领域命令执行，使用乐观并发或 compare-and-set，并记录操作者、原因、前后状态、时间、Trace ID 和错误码。

图谱投影只作为未来状态轴扩展方式记录在 ADR 中，阶段 1 不创建图谱任务、状态、表或 DoD。

## 11. RabbitMQ 任务协议原则

PostgreSQL 是逻辑任务、Attempt、Generation、取消和 Dead Letter 的唯一事实源。RabbitMQ 只投递某个明确 Attempt 的执行命令。

任务消息至少包含：

```text
messageId / eventId
eventType
schemaVersion
tenantId
traceId
jobId
stepId
attemptId
executionGeneration
idempotencyKey
deadline
resource identifiers and immutable version references
```

协议必须满足：

- Publisher Confirm 成功后 Outbox 才可标记已发布。
- Worker 成功提交幂等副作用和状态后才 ACK。
- 业务重试只能创建新 Attempt；人工重放创建新 Generation，不能复活旧执行。
- 取消更新 PostgreSQL；迟到消息在执行副作用前校验 Generation 和取消状态。
- RabbitMQ TTL/DLX 只负责投递调度，不能与 PostgreSQL 各自创建独立业务重试。
- Broker DLQ 消息和 PostgreSQL `dead_letter` 必须可一一关联。
- 旧 Generation、过期 Deadline、已完成幂等键和无法识别的 Schema 必须明确 ACK、拒绝或隔离，不能无限 requeue。

具体 ACK/requeue 表、重试所有者和 DLQ 重放流程由工程评审确认。

## 12. Parser 长任务协议

Node Worker 调用 Python Parser 时使用异步任务协议，不用无界长 HTTP 请求承载全部解析：

- `contentHash + parserVersion` 作为业务幂等基础。
- Parser 返回独立 `parserTaskId`。
- 支持状态查询或有界长轮询。
- ParseArtifact 通过临时对象写入、校验和原子提交后才标记完成。
- 支持 Deadline、取消意图和 `executionGeneration` 校验。
- 调用方能够区分“未开始、运行中、完成但响应丢失、失败和已取消”。

Parser 只产出版本化解析产物，不修改文档审核状态、Release 或线上索引。

## 13. 引用、风险和 SSE

回答风险分为普通和高风险两类，具体分类规则由工作台 Answer Policy 决定：

- 普通问题可以流式发送草稿，但最终快照必须携带引用验证状态；无据句需要删除、改写或明确标记。
- 高风险问题在引用和事实校验通过前不得向客户端发送事实正文；验证失败时返回拒答、证据列表或人工升级建议。
- 不展示或存储模型原始 Chain-of-Thought，只保存阶段、证据摘要、工具结果和可审计 Trace。
- SSE 使用 `runId + seq` 持久化可展示事件，支持断线续读和最终快照。
- 引用状态至少能够表达 `pending / verified / weak / conflict / blocked / expired`；存在未解决 `CONFLICT` 时不能提交为 `ANSWERED`，只能进入 `PARTIAL`、`EVIDENCE_ONLY` 或 `REFUSED`。

## 14. quick_parse 与 Replay

临时资料复用主系统的文件安全、Parser、授权、引用和模型外发策略，但生命周期独立，按需启用 Embedding，不默认执行完整长期入库和 Release 流程。quick_parse 可以产生会话级引用，但必须标记为 `TEMPORARY`；它不是长期正式知识来源，TTL、主动删除或内容清理后引用转为 `EXPIRED`/墓碑。

Replay 分级为：

- `FULL`：临时证据仍在保留期内，可以重放证据和配置。
- `METADATA_ONLY`：仅保留哈希、版本、ID、指标和删除墓碑，不能恢复原文。
- `EXPIRED`：因 TTL 或合规删除无法重放。

隐私删除优先于可复现性。删除后的引用只显示墓碑和审计元数据，不继续展示正文。

黄金集只使用合成或具有独立长期保留授权的脱敏测试语料，保存在与业务资料分离的评测作用域。业务资料删除不会被评测“豁免”；一旦黄金题依赖的证据被合法删除，该题必须生成新版本、替换证据或标为不可运行，不能从历史 RetrievalSnapshot 恢复正文。

## 15. 数据分级、保留与删除

阶段 1 只允许合成或严格脱敏数据进入云端 Chat、Embedding、Reranker 和引用验证。输入、派生摘要和输出继承参与数据的最高等级；`UNKNOWN` 和敏感内容默认禁止外发，不能通过切换供应商绕过。

数据生命周期矩阵必须覆盖：

- PostgreSQL 业务数据、审计、AnswerRun 和 Manifest。
- OpenSearch 文档与 Chunk 投影。
- MinIO 原文件、ParseArtifact、图片、证据和 ReplayBundle。
- Redis 缓存、会话和 quick_parse 临时对象。
- RabbitMQ 活跃消息、重试队列和 DLQ。
- Trace、日志、指标和备份。
- 云模型供应商可能保存的请求、响应和日志。

每类数据必须明确数据等级、允许位置、加密、默认 TTL、最长保留期、Legal Hold 行为、删除目标、墓碑、备份处置、供应商承诺和删除证明。

删除以 `deletion_request` 为业务命令，以各存储的 `deletion_target` 为执行和证明单位。只有所有强制目标完成或进入合法保留状态后，删除请求才可关闭。

## 16. 反馈、评测与发布门禁

阶段 1 包含基础反馈闭环，不能只做点赞和点踩：

- 客服回复草稿采纳率和修改率。
- 获得可用首稿的耗时。
- 升级建议准确率。
- 引用点击率和纠错率。
- 无据回答率。
- 拒答合理性。

发布门禁分两层：

### 16.1 系统硬门禁

- 跨租户、跨工作台和越密级证据泄漏为 0。
- 上传、审核、解析、索引、检索、引用、拒答和回滚主链可运行。
- 引用可回跳当前用户有权访问的不可变原文位置。
- 无依据问题拒答或明确标记不确定。
- RabbitMQ 重复投递、迟到消息、取消、DLQ 和重放可验证。
- Alias 激活失败和 PostgreSQL/OpenSearch 状态分裂可恢复。
- 删除矩阵、墓碑和删除证明可验证。
- 50 道黄金题可在固定 Manifest 和 RetrievalSnapshot 上重复运行。

### 16.2 候选质量目标

- Recall@5：0.92。
- 引用覆盖率：0.96，同时必须设置引用正确率。
- 忠实度：0.95。
- P50 1.2 秒只能作为候选目标，必须拆分检索、Rerank（云 rerank 已实测独立计时：64 候选 0.95 秒、1024 候选 3.4-6.6 秒）、TTFT、引用验证和完整回答时延。

这些数字在测量口径、数据集和真实基线建立前不冒充当前成绩或生产 SLO。

阶段 1 的性能与费用边界按工程评审固化：`ingestion/evaluation` 使用独立 Worker 进程、队列、并发和预算池；OpenSearch 单次查询最多 fan-out 2 个 KnowledgeSpace、融合候选最多 1024、请求总超时 250 ms；ACL 候选权威复核 P95 不超过 60 ms 且不计入该 250 ms；**进 Reranker 的候选数是独立配置（待拍板，实现侧先按 64），rerank 时延与费用独立计量、不计入 250 ms**（PROBE-005 Stage C 实测 1024 候选 3.4-6.6 秒 / ¥0.16，全量 rerank 会把每日 16 元压到约 100 次问答）；引用验证常规路径不超过 2.0 秒、高风险路径不超过 3.5 秒（ADR-0027 已按 PROBE-005 实测由 600 ms / 1.5 s 修订，高风险路径要求逐句 Embedding 与蕴含校验并发发起）；高风险正文缓冲最多 2,048 output tokens；模型费用在 PostgreSQL 预算账本内调用前预扣，单次不超过 5 元、每日不超过 16 元、月度不超过 500 元；用户级配额为并发 AnswerRun 1、并发 SSE 2、提问 10 次/分钟与 200 次/日、上传 20 个/小时。任何超限必须进入排队、降级、证据模式或拒答，不允许自动突破硬上限。

### 16.3 阶段 1 能力门槛

- `quick_parse`、`FULL/METADATA_ONLY/EXPIRED` Replay 分级、删除墓碑和引用证据保留属于可信主链硬 DoD，因为它们直接决定临时资料能否安全使用和删除后能否解释历史结果。
- 知识变更影响分析和运营收件箱属于主链完成后的条件项。阶段 1 必须交付最小可运行入口、数据契约和失败状态；完整历史重放、复杂排序、批量运营界面和自动扩展可在核心主链门禁通过后完成，不得阻塞上传到可引用回复草稿的主链。
- 评测、审计和删除的最小 API、事件及数据产物是硬 DoD；高级报表和可视化不是阶段 1 硬门禁。
- 删除治理、评测与运维三个管理控制台（`/admin/deletions`、`/admin/evaluations`、`/admin/operations`）是硬 DoD，因为删除证明、预算熔断和恢复演练必须有界面可人工验证。

## 17. 实施路径

正式编码前完成六个可丢弃架构探针：

1. Keycloak Realm 初始化、OIDC Authorization Code + PKCE、Token 校验、用户映射、会话过期、撤权和不可用恢复。
2. 固定版 RAGFlow DeepDOC 的打包、启动、资源占用和 ParseArtifact。
3. OpenSearch 多索引 Alias、Release 固定、原子切换、对账、回滚，以及 kNN engine/参数选型与带过滤召回衰减。
4. RabbitMQ retry、cancel、stale message、DLQ 和 replay。
5. 云模型 Chat、Embedding、Reranker、结构化输出、流式取消、错误映射和预算账本预扣（供应商基线见 ADR-0017）。
6. 分块参数与引用定位：在固定语料上比较候选分块组合的 Recall@5、引用可定位率、截断率和索引体积，冻结 `ChunkingManifest` 默认值。

另有 PROBE-000 环境门禁作为前置条件，它验证本地工具链与 Docker 可用性，不属于架构假设验证。

架构探针只验证高风险事实，不形成第二条产品主链。

阶段 1 按以下九个交付增量实施，建议弹性周期为 24 至 36 周：

1. 身份、业务用户、工作台成员和统一授权决策。
2. 一次性上传、安全扫描和不可变知识资产。
3. Parser Artifact、来源定位和质量门禁。
4. Outbox/RabbitMQ 入库、投影和 Candidate Release。
5. 固定 RetrievalSnapshot 的 ACL 前置混合检索。
6. AnswerRun、风险分级引用和可恢复 SSE。
7. Replay 和知识变更影响分析。核心 DoD 是 Replay 分级、删除墓碑和最小影响分析入口；完整历史重放和复杂影响排序属于增强条件。
8. 反馈审核、评测门禁和运营收件箱。核心 DoD 是反馈事件、客服结果指标和黄金集门禁；批量运营收件箱和自动扩展属于增强条件。
9. 删除、恢复、告警和故障演练。

其中第 2 至第 6 项组成第一条端到端客服纵向主链；第 1、7 至第 9 项是保证该主链可授权、可运营和可删除的横切闭环。工程评审必须把九个交付增量拆成可独立验收的工作项，不能把“先搭完全部身份/消息/删除基础设施”当作用户不可见的前置大阶段。

每个交付增量都必须给出独立 DoD，至少包含：用户可见结果、入口和出口条件、依赖、跨模块主链、权限检查、失败注入、审计事件、指标、自动测试、演示步骤、回滚或恢复方式和交付产物。不能只完成页面或 Happy Path。

24 至 36 周是规划窗口，不是承诺，也是本项目周期口径的唯一事实来源（功能报告中的 16 至 24 周是早期估算，已作废）。六个架构探针完成后必须基于资源、外部能力和逐片 DoD 重新估算；如果窗口不成立，优先减少首批格式、运营界面和影响分析覆盖面，不删除身份、权限、引用、消息幂等、发布回滚和数据删除等可信主链门禁。

## 18. 阶段 1 非目标

以下内容明确后置，不作为阶段 1 完成条件：

- 研发和普通员工完整工作台。
- Git、Confluence、SharePoint、网盘和真实工单系统连接器。
- GraphRAG、RAPTOR、Neo4j 和知识图谱运营台。
- 通用 Agent、任意工具调用和自动写操作。
- 音视频、多模态向量和跨语言检索。
- 完整 ABAC 策略设计器和企业外部权限同步。
- 独立 Model Gateway、完整微服务拆分和插件市场。
- 本地大模型、GPU 调度和模型训练。
- 生产 Kubernetes、多地域灾备和生产容量承诺。
- MongoDB 和独立向量数据库。

后置的是实现和运营界面，不是权限、版本、证据、任务和数据生命周期协议。

## 19. 方案比较与选择

### 方案 A：RAG Demo

只实现文档向量化、相似度检索和聊天。交付快，但无法验证权限、审核、发布、删除、引用和恢复，已拒绝。

### 方案 B：功能铺开的平台 MVP

同时实现多角色工作台、连接器、GraphRAG、Agent 和多模态。展示面广，但单人项目会产生过多未闭合的状态组合和外部边界，已拒绝。

### 方案 C：完整基座、单一客服纵向闭环

使用正式领域边界和中间件实现一条客服主链，高级能力按稳定契约后置。该方案被选中，因为它同时满足学习深度、企业级质量和未来演进性。

## 20. `plan-eng-review` 闭合项索引

以下 13 类问题已在工程评审闭合记录中形成字段级、状态级、消息级、删除级、SSE 级、性能级和交付级协议；它们仍需要在实现阶段通过测试和探针验证：

1. `ReleaseManifest`、`ReleaseActivation`、`IndexActivationIntent`、`RetrievalSnapshot` 和三个 Pipeline Manifest 的字段、主键、不可变规则、哈希和兼容矩阵。
2. Release、IndexPartition、KnowledgeSpace、Workspace 和物理索引/Alias 的唯一作用域与保留预算。
3. 所有正交状态枚举、合法迁移、并发控制、终态和派生条件。
4. RabbitMQ ACK/requeue、Retry Owner、取消、迟到消息、DLQ 关联和重放协议。
5. Parser 异步任务 API、原子 ParseArtifact 提交和响应丢失恢复。
6. 数据分级、Retention、Legal Hold、备份和供应商留存矩阵。
7. SSE 事件协议、风险分级缓冲、引用验证失败和断线续读。
8. quick_parse 的 FULL/METADATA_ONLY/EXPIRED 保留期限和删除优先级。
9. 九个交付增量的逐项 DoD、测试覆盖图和失败模式登记表，并标记第 2 至第 6 项为纵向主链、第 1、7 至第 9 项为横切闭环。
10. 性能预算、Worker 并发池、RabbitMQ prefetch、OpenSearch fan-out、模型费用上限和用户级配额。
11. 多知识空间的确定性全序合并与 `CONFLICT` 判定，以及授权从作用域预过滤、候选权威复核到引用预览/下载的传播规则。
12. 六个架构探针的实测资源预算、首批文件格式、kNN 与分块冻结参数、最小观测/评测栈和 24 至 36 周重估结果。
13. 不可信文档内容与 Prompt Injection 的三处检测、状态字段、失败行为和独立注入样本集。

这些是正式编码前的架构闭合项，不代表回退到 Demo，也不授权无限扩展范围。

## 21. 成功标准

本文完成后的直接成功标准是：

- 后续会话不需要重新确认产品定位、首期角色、技术基线和参考仓库复用方式。
- `plan-eng-review` 能以本文作为产品和架构边界输入，集中审查协议和 DoD。
- 任何实现任务都能归属九个交付增量之一，并能说明对应的用户结果和系统门禁。
- 阶段 1 不因增加未来能力而复制主链、绕过正式中间件或引入第二事实源。

## 22. 下一项行动

`plan-eng-review` 已闭合第 20 节列出的协议和 DoD。下一步先完成探针收尾提交，再按 [阶段 1 实施 Tickets](../engineering/stage1-implementation-tickets.md) 的 T0 建立仓库骨架，并以 T1a/T1b、T2-T16 进入纵向实现；探针只验证高风险事实，不另起 Demo 主链。测试入口见 [工程评审测试计划](../engineering/plan-eng-review-test-plan.md)。

## 23. 本次确认记录

- 产品目标：个人孵化和学习，但按长期可演进的企业级基础建设。
- 首期产品：客服知识助手。
- 基座策略：共享基座，其他角色后续扩展，不创建产品分支。
- 范围策略：正式基础边界完整，高级能力后置。
- 复用策略：固定快照 + Adapter 包装 + 按协议逐步自研。
- 纵向闭环：客服上传至可引用回复草稿和反馈评测。
- Model Gateway：阶段 1 不独立部署。
- 反馈：阶段 1 纳入基础闭环和客服结果指标。
- 云模型：仅处理合成或严格脱敏数据，未知和敏感内容默认阻断。
- 交付：本地 Docker Compose、项目文档和 CI 门禁，不部署生产环境。
- 成功标准：系统硬门禁与客服结果指标并行。
- 实施方式：正式中间件和协议驱动的纵向切片。
- 非目标：按第 18 节明确后置。

## 24. 工程评审闭合状态

第 20 节列出的 13 类工程闭合项已经形成字段级、状态级、消息级、删除级、SSE 级和交付级协议。当前结论不是“已完成实现”，而是“实现前的架构契约已固定”。

- 已闭合：Manifest/Release/IndexPartition 作用域（唯一键含 `embeddingVersion`）、不可变规则和兼容矩阵。
- 已闭合：正交状态机、终态、并发控制和可检索派生条件。
- 已闭合：RabbitMQ 拓扑、ACK/requeue、重试所有者、取消、DLQ 和人工重放。
- 已闭合：Parser 长任务、原子 ParseArtifact 和响应丢失恢复。
- 已闭合：数据分级、试点默认 Retention、Legal Hold、删除目标和删除证明，以及回答正文的三层存储归属。
- 已闭合：SSE 事件、风险分级缓冲、引用验证分层预算、断线续读与快照回落。
- 已闭合：quick_parse 的 FULL/METADATA_ONLY/EXPIRED 默认期限和删除优先级。
- 已闭合：授权两段判定（作用域预过滤 + 候选权威复核）与跨空间冲突的全序消解。
- 已闭合：逐文档授权扩展点（阶段 1 预留不实现）、quick_parse `TEMPORARY` 引用、ModelAdapter 调用上下文、Pipeline/Release 关系、EvidenceSnapshot 删除目标、`CONFLICT` Finalizer 门禁、Redis 故障时并发兜底和 T1a/T1b 依赖拆分（见 [ADR-0036](../adr/0036-stage1-protocol-clarifications.md)）。
- 已闭合：预算账本的预扣、结算、lease 回收和三个上限的自洽口径。
- 已闭合：不可信内容与 Prompt Injection 的检测点、状态字段、失败行为和注入样本集 DoD。
- 已闭合：九个交付增量的逐项 DoD、测试覆盖和失败模式登记（F-01 至 F-30）。
- 已闭合：首批格式门禁、六个架构探针的验收协议、性能硬上限、用户级配额和资源基线的测量方法。
- 仍需实测：六个架构探针的登录与撤权行为、资源峰值、外部模型真实延迟与费用、解析质量、kNN 与分块冻结参数、OpenSearch 查询预算和 24 至 36 周重估结果。

详细字段、矩阵、ASCII 图、测试覆盖图、Failure Modes Registry、实施任务和并行化策略统一维护在工程评审闭合记录中；若实现阶段发现协议无法满足真实约束，必须通过 ADR 取代并同步本文。

## 25. 对设计取向的观察

- 你明确拒绝“只做向量化、索引和聊天”的 Demo，要求 MVP 也拥有长期可演进的基座。
- 你选择 RabbitMQ、MinIO、OpenSearch 和 DeepDOC，不是为了堆组件，而是希望完整学习可靠异步、对象存储、混合检索和复杂文档解析。
- 你接受拉长实现周期，并反复强调未来扩展不能依靠大规模重构，这决定了本方案以稳定协议和纵向切片控制复杂度。
- 你同意首期聚焦客服工作台，说明“完整”指工程边界完整，而不是同时做完所有产品角色。
