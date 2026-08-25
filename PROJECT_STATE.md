# 企业级可信多模态 RAG 项目状态

> 这是本项目的会话无关状态入口。新会话先读本文件，再按“事实源层级”读取详细文档；不要把聊天上下文当作唯一事实来源。
>
> 最近更新：2026-08-25

## 一句话结论

本项目不是“向量化文档 + 聊天”的 Demo，而是一个企业级可信 RAG 基础 MVP：共享基座、客服单一纵向闭环，正式覆盖身份、权限、不可变文档版本、异步解析与索引、版本化 Release、混合检索、句级引用、删除、恢复、审计和评测；研发与普通员工工作台后续复用同一基座扩展。

当前状态：架构和工程协议已完成评审，并已通过 ADR-0025 至 ADR-0036 把授权、引用预算、Embedding 分区、预算账本、回答正文存储、分块冻结、注入防护、冲突消解、用户级配额、运行期硬协议和复审后的协议语义收敛提升为 ADR 级事实；当前进入“架构探针阶段”；尚无业务实现、构建结果、测试结果或真实性能基线。探针阶段有独立 Plan、1 张环境门禁 Ticket 和 6 张探针 Tickets，探针通过后才冻结最终开发 Plan/Tickets。

## 事实源层级

发生冲突时按以下顺序处理：

1. 用户在当前会话中的明确新决策。
2. 本文件的“当前已确认决策”和“当前状态”。
3. `docs/adr/` 中已编号的 ADR。新增或反转架构决策必须新增 ADR，不直接改写历史 ADR。
4. [企业级可信 RAG 基础 MVP 产品与架构边界](docs/design/企业级可信RAG基础MVP-产品与架构边界.md)。
5. [工程评审闭合记录](docs/engineering/plan-eng-review-closure.md) 和 [工程评审测试计划](docs/engineering/plan-eng-review-test-plan.md)。
6. [TS 企业级多模态 RAG 技术设计方案](技术设计方案-TS企业级多模态RAG.md)。
7. [CONTEXT.md](CONTEXT.md) 的领域术语。
8. 聊天记录、临时讨论和未写入文档的推断。

如果实现发现协议与真实中间件行为冲突，先记录证据，再通过 ADR 变更，并同步本文件和相关设计文档。

## 当前已确认决策

### 产品与范围

- 首期产品是客服知识助手，不做通用企业知识库产品。
- 首期只做客服工作台的一条完整纵向链路：登录 → 上传 → 安全检查 → 解析 → 分块/Embedding/关键词索引 → Candidate Release → 审核/发布 → ACL 混合检索 → Rerank Top5 → 引用验证 → 可复制回复草稿 → 反馈/评测。
- 共享基座不按客服、研发、普通员工复制分支；角色差异通过 Workspace、KnowledgeSpace、数据源、策略和工具权限表达。
- 研发工作台未来接入代码仓库和研发文档；普通员工工作台未来接入制度和业务资料；阶段 1 不实现完整工作台。
- MVP 使用合成或严格脱敏数据，不接入真实敏感客户数据，不自动向终端客户发送消息。
- 计划周期为 24 至 36 周弹性窗口，不是承诺；六个探针后重新估算。功能报告中的 16 至 24 周为早期估算，已作废。

### 技术基线

- 前端：Next.js + TypeScript。
- 后端：NestJS 模块化单体。
- Worker：一个 `apps/worker` 代码库，两个独立启动 Profile：`ingestion`、`evaluation`。
- Parser：独立 Python Parser Service，包装固定版本 RAGFlow DeepDOC。
- 数据与中间件：PostgreSQL + Prisma、OpenSearch、RabbitMQ、Redis、MinIO、Keycloak/OIDC。
- 模型：阿里云百炼，通过内部 `ModelAdapter` 接入 Chat、Embedding、Reranker 和引用验证；阶段 1 不部署独立 Model Gateway。
- 本地环境：32 GiB 主机，WSL2 日常上限 22 GiB；DeepDOC/批量评测可显式使用 24 GiB profile。
- 对象存储：阶段 1 本地 MinIO；阿里云 OSS 保留未来适配，不进入当前本地主链。

### 核心架构不变量

- PostgreSQL 是业务事实、任务状态、Outbox、审计和删除事实的权威来源。
- RabbitMQ 只负责传递和延迟；逻辑任务、Attempt、Generation、取消和 DLQ 关联由 PostgreSQL 管理。
- OpenSearch 物理作用域固定为 `tenant_id + knowledge_space_id + index_partition_id`；`IndexPartition` 唯一键为 `(tenantId, knowledgeSpaceId, dataClass, indexSchemaVersion, embeddingVersion)`（ADR-0028）。
- 授权分两段：PostgreSQL 编译 `acl_scope_key` 集合作为索引预过滤，候选合并后再做一次批量 PostgreSQL 权威复核；索引内不存储主体列表或 ACL 版本号，复核超时或 PostgreSQL 不可用时整个查询 fail closed（ADR-0026）。阶段 1 授权模型为纯作用域型；逐文档正向授权是加法、只能进预过滤，作为已识别扩展点预留但不实现（ADR-0036）。
- Workspace 不写入索引事实，不复制文档和 Chunk；Workspace 通过绑定 KnowledgeSpace 和策略组合查询范围。
- 文档版本不可变；Parser、Chunker、Embedding、Index Schema、Retrieval、Answer 等通过不可变 Manifest 固定组合。
- Release、ReleaseActivation、IndexActivationIntent 和 RetrievalSnapshot 不可被一个可变状态字段替代。
- 删除墓碑、Legal Hold、授权事实和有效期校验优先于发布、回滚、DLQ 重放和索引重建；`aclRevision` 只用于失效 Redis 作用域缓存。
- `AnswerModule` 只生成候选答案；`CitationModule` 负责句切分、引用回填和验证；`AnswerFinalizer` 只提交经过允许验证状态的最终快照，未解决 `CONFLICT` 不得提交为 `ANSWERED`；任何模块不得跨阶段直接调用 `ModelAdapter` 代做别的阶段的工作（ADR-0035、ADR-0036）。
- 回答正文分三层存储：PostgreSQL 只存元数据和载荷哈希，Redis `run:{runId}:events` TTL 24 小时只作 SSE 续读窗，对象存储快照是唯一长期正文副本（ADR-0030）。
- 模型费用以 PostgreSQL `model_budget_ledger` 为硬门禁，调用前预扣并带 lease，结算释放差额，lease 过期回收；数据等级准入在 `ModelAdapter` 层强制，不在调用点（ADR-0025、ADR-0029）。
- 文档内容永远是数据不是指令；注入检测有解析、进入生成上下文前和回答输出后三处，`suspected` 内容不进入生成上下文（ADR-0032）。quick_parse 可产生 `TEMPORARY` 会话级引用，但不进入正式 Release，清理后转为 `EXPIRED`/墓碑（ADR-0036）。
- 跨知识空间证据冲突按确定性全序键消解，模型不裁决冲突；权威级别与适用范围并列且结论不相容时判为 `CONFLICT` 并同时展示来源，最终结果只能是 `PARTIAL`、`EVIDENCE_ONLY` 或 `REFUSED`（ADR-0033、ADR-0036）。
- 领域审计同步写 PostgreSQL；Trace、Token、成本和高频遥测异步投递，不让遥测系统成为业务提交依赖；`traceId/spanId` 生成内建，不依赖常驻观测栈。
- 阶段 1 不启动 Neo4j、GraphRAG、RAPTOR、Agent、MongoDB、独立向量数据库、Kafka/NATS、生产 Kubernetes。
- `PipelineManifest` 是兼容批准组合，不是 Release 的父对象；`ReleaseManifest` 只引用 `ingestionManifestId`，`RetrievalSnapshot` 记录 Release 集合、共同 Retrieval/Answer 策略和兼容校验结果（ADR-0036）。

## 当前硬边界

### 资源与并发

| 组件 | 硬边界 |
|---|---|
| `worker:ingestion` | 并发 4，最大 in-flight 8；解析 `prefetch=1`，投影 `prefetch=4` |
| `worker:evaluation` | 独立进程， 并发 1，最大 in-flight 1，独立队列和预算池 |
| DeepDOC Parser | 并发 1，单进程 RSS 警戒 8 GiB |
| OpenSearch | 单次最多 fan-out 2 个 KnowledgeSpace，候选最多 1024，请求总超时 250 ms |
| ACL 候选权威复核 | P95 <= 60 ms，不计入上面的 250 ms；超时整个查询 fail closed |
| 引用验证 | 常规路径 <= 600 ms，高风险路径 <= 1.5 s |
| 高风险回答 | 验证通过前不发送事实正文，生成缓冲最多 2,048 output tokens |
| 模型预算 | PostgreSQL `model_budget_ledger` 预扣：单次 <= 5 元，每日 <= 16 元，月度 <= 500 元；交互池 350、评测池 100、应急 50 元（16 × 31 = 496，三个上限自洽） |
| 用户级配额 | 并发 AnswerRun 1，并发 SSE 2，提问 10 次/分钟与 200 次/日，上传 20 个/小时，重建并发 1/租户 |

超过边界时只能排队、暂停、降级、`EVIDENCE_ONLY` 或 `REFUSED`，不允许运行时自动突破上限，也不允许通过跳过引用验证或缩小候选集来“满足”请求。

### 质量指标口径

- 越权证据泄漏：硬门禁，必须为 0。
- 主链、引用回跳、无据拒答、删除证明、回滚和 50 道固定黄金题：硬门禁。
- 注入样本集：独立于业务黄金集；硬门禁是不越权泄漏、不触发工具或外链调用、不把未验证正文提交为最终快照，检出率与误报率只报告不阻断。
- 三个管理控制台 `/admin/deletions`、`/admin/evaluations`、`/admin/operations`：硬 DoD，因为删除证明、预算熔断和恢复演练必须有界面可人工验证。
- Recall@5 0.92、引用覆盖率 0.96、忠实度 0.95、P50 1.2 秒：候选目标，不是当前成绩，也不是单一生产 SLO。
- 性能必须拆分 presign/complete、作用域预过滤 + Snapshot、BM25/向量、ACL 候选权威复核、融合/Rerank、TTFT、生成和引用验证（常规 600 ms 与高风险 1.5 s 分列）。

## 已完成内容

- 已阅读并结合当前项目 PDF、固定快照的 ragent 和 RAGFlow 参考代码。
- 已完成 CEO/产品范围审查、独立对抗性审查和工程评审。
- 已闭合 Manifest、Release、IndexPartition、状态机、RabbitMQ、Parser、SSE、引用、删除和 Replay 协议。
- 已完成一次全仓设计复审，并把 17 项发现全部落地为 ADR 或文档修订：[design-fix-log-20260824.md](docs/engineering/design-fix-log-20260824.md)。
- 已新增 ADR-0025 至 ADR-0036：数据等级准入点、`acl_scope_key` 两段授权、分层引用验证预算、Embedding 版本分区与重建、预算账本与上限、回答正文三层存储、分块探针后冻结、注入防护、确定性冲突消解、用户级配额、阶段 1 运行期硬协议以及复审后的协议语义收敛提升为 ADR。
- 已建立 `F-01` 至 `F-29` Failure Modes Registry。
- 已生成测试覆盖图、测试计划和 T1a/T1b、T2-T13 实施任务。
- 已生成仓库内 JSONL 任务产物：[tasks-eng-review-20260824.jsonl](docs/engineering/tasks-eng-review-20260824.jsonl)；它是设计复审前的评审快照，只含 T1-T12，任务范围以[工程评审闭合记录](docs/engineering/plan-eng-review-closure.md)第 16 节为准，最终 Tickets 在 Probe Decision Gate 后冻结。
- 已生成架构探针总计划：[architecture-probes-plan.md](docs/engineering/architecture-probes-plan.md)。
- 已固化复审后的协议语义收敛：[ADR-0036](docs/adr/0036-stage1-protocol-clarifications.md)，涉及逐文档授权扩展点（阶段 1 预留不实现）、quick_parse 临时引用（纳入实现）、ModelAdapter 调用上下文、Pipeline/Release 关系、Evidence/Answer 快照归属、CONFLICT Finalizer 门禁、Redis 故障降级和 T1 拆分。
- 已生成 PROBE-000 环境门禁和 6 张探针 Tickets：[docs/engineering/tickets/](docs/engineering/tickets/)。
- 已执行并复检 PROBE-000 环境门禁：Node/pnpm/Python/curl/jq、Docker CE CLI 和 Docker Compose 通过；当前 Codex 执行环境访问 `/var/run/docker.sock` 被拒绝，且沙箱外执行审批服务返回 503，因此 PROBE-001 至 PROBE-006 尚未开始。

## 尚未完成且不能假装完成

- 没有业务实现代码、`package.json`、Prisma schema、Compose、CI 或可运行应用。
- 没有执行构建、类型检查、Lint、单元测试、容器集成测试、Playwright 或部署。
- 六个架构探针尚未实测：Keycloak/OIDC、DeepDOC、OpenSearch（含 kNN engine/参数与带过滤召回衰减）、RabbitMQ、百炼 ModelAdapter（含预算账本预扣）、分块与引用定位。
- 当前环境门禁为 `BLOCKED_ENVIRONMENT`（Docker CE Engine API 执行权限）：需要确认 Docker daemon 已启动，并在允许 Codex 访问 Docker Socket 的执行环境中重新运行 [preflight.sh](scripts/probes/preflight.sh)。
- 尚无真实解析质量、OpenSearch 延迟、模型 TTFT、费用和资源峰值基线；600 ms / 1.5 s 引用验证预算、每日 16 元和用户级配额默认值均为待实测校准的初值。
- `ChunkingManifest` 默认值和 kNN 参数尚未冻结；阶段 1 是否启用 parent-child 由 PROBE-006 决定。
- 当前目录不是有效 Git 仓库，不能依赖 commit、branch 或 diff 判断实现新鲜度。
- `~/.gstack` 评审日志持久化曾因审批服务 503 失败；项目内文档和 JSONL 是当前可靠副本。

## 当前阶段：架构探针

探针阶段先于正式业务开发。探针代码可丢弃，只验证外部事实，不建立第二条产品主链。

探针状态：

| 探针 | 主题 | 状态 | 结果 |
|---|---|---|---|
| PROBE-000 | 本地工具链与 Docker CE 环境门禁 | BLOCKED | 当前 Codex 执行环境无 Docker Engine API/Socket 权限；沙箱外审批服务 503 |
| PROBE-001 | Keycloak/OIDC、Token、撤权、不可用恢复 | 待环境门禁 | 尚未执行 |
| PROBE-002 | RAGFlow DeepDOC、ParseArtifact、资源和定位质量 | 待环境门禁 | 尚未执行 |
| PROBE-003 | OpenSearch、Alias、`acl_scope_key`、kNN 参数、带过滤召回、回滚和查询预算 | 待环境门禁 | 尚未执行 |
| PROBE-004 | RabbitMQ、Retry、Cancel、DLQ、Replay | 待环境门禁 | 尚未执行 |
| PROBE-005 | 百炼 ModelAdapter、Chat/Embedding/Reranker/引用验证、预算账本、真实延迟与费用 | 待环境门禁 | 尚未执行 |
| PROBE-006 | 分块参数与引用定位，冻结 `ChunkingManifest` | 待 PROBE-002/003 | 尚未执行 |

PROBE-000 是门禁而不是架构假设验证，不计入六个探针，但它 `BLOCKED` 时其余探针一律不启动。PROBE-006 复用 PROBE-002 的解析产物，PROBE-002 `BLOCKED` 时它没有输入。

决策门：六个探针全部为 `PASS` 或 `PASS_WITH_ADJUSTMENT` 后，更新 ADR、PROJECT_STATE、设计方案和工程评审记录，再把 T1a/T1b、T2-T13 冻结为最终开发 Tickets；任一探针为 `BLOCKED` 时暂停大规模业务实现。

## 下一步执行顺序

1. 确认 Docker CE daemon 已启动且当前用户可访问 Docker Socket，重新运行 [preflight.sh](scripts/probes/preflight.sh)，让 PROBE-000 转为 `PASS`。
2. 环境门禁通过后，按 [架构探针阶段计划](docs/engineering/architecture-probes-plan.md) 并行执行 PROBE-001、PROBE-002、PROBE-003，随后执行 PROBE-004、PROBE-005、PROBE-006。
3. 每个探针保存 Markdown/JSON 结果、输入指纹、版本、资源/延迟测量、失败行为和结论；DeepDOC、批量 ModelAdapter 评测和 PROBE-006 重建不得同时占用 24 GiB profile。
4. 通过 Probe Decision Gate，冻结 kNN 参数与 `ChunkingManifest` 默认值，必要时新增 ADR 或调整硬边界。
5. 运行一次增量 `plan-eng-review`，只复审探针改变的假设，并按实测重估 24 至 36 周窗口。
6. 冻结最终开发 Plan/Tickets，先实现 T1a Manifest/Prisma Core、T2 状态命令和 T3 RabbitMQ 协议；T1b Chunk/Index Schema 等 PROBE-006 后再实现。
7. 继续 T4 Parser/ObjectStorage、T5 Release/OpenSearch、T6 Retrieval、T7 Answer/Citation、T8 Deletion/Replay。
8. 最后完成 T9 Evaluation、T10 Worker 资源、T11 审计/遥测和 T12 性能/费用门禁；T13 不可信内容与注入检测随 T4/T6/T7 分别落地，不单独排在最后。

## 详细文档入口

- 领域术语：[CONTEXT.md](CONTEXT.md)
- 产品与架构边界：[docs/design/企业级可信RAG基础MVP-产品与架构边界.md](docs/design/企业级可信RAG基础MVP-产品与架构边界.md)
- 工程评审闭合记录：[docs/engineering/plan-eng-review-closure.md](docs/engineering/plan-eng-review-closure.md)
- 工程评审测试计划：[docs/engineering/plan-eng-review-test-plan.md](docs/engineering/plan-eng-review-test-plan.md)
- 架构探针总计划：[docs/engineering/architecture-probes-plan.md](docs/engineering/architecture-probes-plan.md)
- 设计复审修复记录：[docs/engineering/design-fix-log-20260824.md](docs/engineering/design-fix-log-20260824.md)
- 架构图：[diagrams/ts-rag-architecture.mmd](diagrams/ts-rag-architecture.mmd)
- 探针 Tickets：[docs/engineering/tickets/](docs/engineering/tickets/)
- 实施任务 JSONL：[docs/engineering/tasks-eng-review-20260824.jsonl](docs/engineering/tasks-eng-review-20260824.jsonl)
- TS 技术设计方案：[技术设计方案-TS企业级多模态RAG.md](技术设计方案-TS企业级多模态RAG.md)
- ADR 目录：[docs/adr/](docs/adr/)
- 参考仓库：[references/ragent/](references/ragent/)、[references/ragflow/](references/ragflow/)

## 新会话恢复规则

新会话按以下顺序恢复：

1. 读取本文件，确认当前状态、硬边界和下一步。
2. 读取 `CONTEXT.md`，获得领域术语和禁止混用的概念。
3. 根据当前任务读取对应 ADR、设计文档或工程评审章节，不要一次加载所有参考仓库。
4. 如果用户提出新架构方向，先检查是否与本文件的已确认决策冲突；冲突时明确指出并新增 ADR，不静默覆盖。
5. 如果开始实现，先更新本文件的“尚未完成”和“下一步执行顺序”，实现后再写验证结果。
