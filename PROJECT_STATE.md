# 企业级可信多模态 RAG 项目状态

> 这是本项目的会话无关状态入口。新会话先读本文件，再按“事实源层级”读取详细文档；不要把聊天上下文当作唯一事实来源。
>
> 最近更新：2026-09-02

## 一句话结论

本项目不是“向量化文档 + 聊天”的 Demo，而是一个企业级可信 RAG 基础 MVP：共享基座、客服单一纵向闭环，正式覆盖身份、权限、不可变文档版本、异步解析与索引、版本化 Release、混合检索、句级引用、删除、恢复、审计和评测；研发与普通员工工作台后续复用同一基座扩展。

当前状态：架构和工程协议已完成评审，六个架构探针的外部事实已完成（PROBE-001~004 为 `PASS`，PROBE-005~006 为 `PASS_WITH_ADJUSTMENT`）；T0 Monorepo 与本地开发基线已真实环境验收通过（2026-08-28）；**T1a Manifest/Prisma Core 切片 + devex P1 三项已于 2026-09-01 获用户 `ACCEPTED_WITH_ACTIONS`**（条件见[验收记录 §6](docs/engineering/acceptance/hg-01-t1a-manifest-core.md#6-用户验收结论)：租户谓词与请求体 `tenantId` 退场归 T14 DoD，幂等重放 201→200 归 T2）。HG-01 门禁本身尚未通过——完整范围还差 T12(Ledger/配置骨架)、T11(同步审计)、T14(身份与授权)，三者未开始，因此 T2/T10/T3/T1b 仍未解锁。除 T1a 的 Manifest/Release 领域面外尚无业务实现；容器级集成测试（Testcontainers）、Playwright、部署和真实语料性能基线均未验证。探针结果索引、Probe Decision Gate 和 ADR-0037 记录了已冻结事实、集成测试门槛与生产治理遗留项。

## 事实源层级

发生冲突时按以下顺序处理：

1. 用户在当前会话中的明确新决策。
2. 本文件的“当前已确认决策”和“当前状态”。
3. `docs/adr/` 中已编号的 ADR。语义新增或反转必须新增 ADR；实测数值、事实勘误可在原 ADR 中增加 `revised`、修订依据和修订记录，但不得静默覆盖历史依据。
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
- 计划周期为 24 至 36 周弹性窗口，不是承诺。十八张实施票据的工作量估算已于 2026-08-27 补齐，并于 2026-08-31 按 [ADR-0039](docs/adr/0039-business-identity-and-unified-authorization.md) 上调 T14（~6d → ~8d），当前合计 human ~86.5d / CC ~21.1d（见[工程评审闭合记录第 16.1 节](docs/engineering/plan-eng-review-closure.md)）；按经验系数换算，人工为主路径约 29–38 周，上界已超出窗口，机械实现主要由 CC 承担时约 16–24 周。换算系数是假设值，正式重估仍在实现准备增量工程复审中进行。功能报告中的 16 至 24 周为早期估算，已作废。

### 技术基线

- 前端：Next.js + TypeScript。
- 后端：NestJS 模块化单体。
- Worker：一个 `apps/worker` 代码库，两个独立启动 Profile：`ingestion`、`evaluation`。
- Parser：独立 Python Parser Service，包装固定版本 RAGFlow DeepDOC。
- 数据与中间件：PostgreSQL + Prisma、OpenSearch、RabbitMQ、Redis、MinIO、Keycloak/OIDC。
- 模型：通过内部 `ModelAdapter` 接入云侧 Chat、Embedding、Reranker 和引用验证；供应商基线见 [ADR-0017](docs/adr/0017-mvp-cloud-model-and-budget.md)（Embedding = OpenRouter `qwen/qwen3-embedding-8b` `dimensions=1024`；Chat / 高风险蕴含 = fluxionai `gpt-5.6-terra`，OpenAI **Responses** 协议；Reranker = OpenRouter `qwen/qwen3-reranker-8b`，`POST {base}/rerank`）。阶段 1 不部署独立 Model Gateway。阿里云百炼已不再是 MVP 云模型供应商。
- 本地环境：32 GiB 主机，WSL2 日常上限 22 GiB；DeepDOC/批量评测可显式使用 24 GiB profile。
- 对象存储：阶段 1 本地 MinIO；阿里云 OSS 保留未来适配，不进入当前本地主链。

### 核心架构不变量

- PostgreSQL 是业务事实、任务状态、Outbox、审计和删除事实的权威来源。
- RabbitMQ 只负责传递和延迟；逻辑任务、Attempt、Generation、取消和 DLQ 关联由 PostgreSQL 管理。
- OpenSearch 物理作用域固定为 `tenant_id + knowledge_space_id + index_partition_id`；`IndexPartition` 唯一键为 `(tenantId, knowledgeSpaceId, dataClass, indexSchemaVersion, embeddingVersion)`（ADR-0028）。
- 授权分两段：PostgreSQL 编译 `acl_scope_key` 集合作为索引预过滤，候选合并后再做一次批量 PostgreSQL 权威复核；索引内不存储主体列表或 ACL 版本号，复核超时或 PostgreSQL 不可用时整个查询 fail closed（ADR-0026）。阶段 1 授权模型为纯作用域型；逐文档正向授权是加法、只能进预过滤，作为已识别扩展点预留但不实现（ADR-0036）。
- 外部身份与业务用户分离：Keycloak/OIDC 只产出稳定的 `(issuer, subject)`，`BusinessUser` 及租户/Workspace 成员、角色与能力权限由 PostgreSQL 维护；能力权限码只判断能否执行操作，不参与 `acl_scope_key` 编译；租户上下文只能从已验证身份推导，不得信任请求体中的 `tenantId`（ADR-0039）。
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
| 引用验证 | 常规路径 P95 <= 2.0 s，高风险路径 P95 <= 3.5 s（ADR-0027 按 PROBE-005 实测修订；高风险路径要求逐句 Embedding 与蕴含校验并发发起） |
| 高风险回答 | 验证通过前不发送事实正文，生成缓冲最多 2,048 output tokens |
| 模型预算 | PostgreSQL `model_budget_ledger` 预扣：单次 <= 5 元，每日 <= 16 元，月度 <= 500 元；交互池 350、评测池 100、应急 50 元（16 × 31 = 496，三个上限自洽） |
| 用户级配额 | 并发 AnswerRun 1，并发 SSE 2，提问 10 次/分钟与 200 次/日，上传 20 个/小时，重建并发 1/租户 |

超过边界时只能排队、暂停、降级、`EVIDENCE_ONLY` 或 `REFUSED`，不允许运行时自动突破上限，也不允许通过跳过引用验证或缩小候选集来“满足”请求。

### 研发协作与人工验收

- 阶段 1 自 2026-08-28 起执行[阶段人工核验门禁](docs/engineering/manual-acceptance-gate.md)：自动化检查和 Agent 自评只决定是否可进入 `READY_FOR_HUMAN`，不能替代用户人工验收。
- 当前已经运行的并行 Agent 只完成原始分配范围；主 Agent 汇总当前批次后停在 HG-01，用户未明确允许前不得启动下一批次。
- 每次验收必须展示范围、UI 或可操作接口、关键代码与数据流、实际验证、已知风险和未完成项；没有产品 UI 的后端批次必须明确说明，不得让用户从测试结果猜测产品现状。
- 人工验收与 Git/发布授权相互独立；验收通过不自动授权 commit、push、PR、merge 或部署。

### 质量指标口径

- 越权证据泄漏：硬门禁，必须为 0。
- 主链、引用回跳、无据拒答、删除证明、回滚和 50 道固定黄金题：硬门禁。
- 注入样本集：独立于业务黄金集；硬门禁是不越权泄漏、不触发工具或外链调用、不把未验证正文提交为最终快照，检出率与误报率只报告不阻断。
- 三个管理控制台 `/admin/deletions`、`/admin/evaluations`、`/admin/operations`：硬 DoD，因为删除证明、预算熔断和恢复演练必须有界面可人工验证。
- Recall@5 0.92、引用覆盖率 0.96、忠实度 0.95、P50 1.2 秒：候选目标，不是当前成绩，也不是单一生产 SLO。
- 性能必须拆分 presign/complete、作用域预过滤 + Snapshot、BM25/向量、ACL 候选权威复核、融合/Rerank（**云 rerank 已实测独立计时：64 候选 0.95 s、1024 候选 3.4-6.6 s，必须单列且按上界设超时**）、TTFT、生成和引用验证（常规 2.0 s 与高风险 3.5 s 分列）。

## 已完成内容

- 已阅读并结合当前项目 PDF、固定快照的 ragent 和 RAGFlow 参考代码。
- 已完成 CEO/产品范围审查、独立对抗性审查和工程评审。
- 已闭合 Manifest、Release、IndexPartition、状态机、RabbitMQ、Parser、SSE、引用、删除和 Replay 协议。
- 已完成一次全仓设计复审，并把 17 项发现全部落地为 ADR 或文档修订：[design-fix-log-20260824.md](docs/engineering/design-fix-log-20260824.md)。
- 已新增 ADR-0025 至 ADR-0038：数据等级准入点、`acl_scope_key` 两段授权、分层引用验证预算、Embedding 版本分区与重建、预算账本与上限、回答正文三层存储、分块探针后冻结、注入防护、确定性冲突消解、用户级配额、阶段 1 运行期硬协议、协议语义、OpenSearch 字段口径和 VLM 多模态解析后端均提升为 ADR。
- 已按 PROBE-005 实测原地修订 [ADR-0017](docs/adr/0017-mvp-cloud-model-and-budget.md)（供应商基线 + 协议方言边界 + Adapter 十项防护）与 [ADR-0027](docs/adr/0027-tiered-citation-verification-budget.md)（引用验证预算 2.0 s / 3.5 s + 并发硬约束），并同步 [ADR-0035](docs/adr/0035-stage1-runtime-protocol-ratification.md) 的复述值。
- 已建立 `F-01` 至 `F-30` Failure Modes Registry（F-30 为 2026-08-26 按 PROBE-005 Stage C 实测新增的「供应商 429 被误当作契约裁决或排序结果」）。
- 已生成测试覆盖图、测试计划和探针收口后的 T0、T1a/T1b、T2-T16 实施任务；旧 JSONL 仅保留为评审快照。
- 已生成仓库内 JSONL 任务产物：[tasks-eng-review-20260824.jsonl](docs/engineering/tasks-eng-review-20260824.jsonl)；它是设计复审前的旧快照，只含 T1-T12，不是当前任务清单。当前任务范围以[阶段 1 实施 Tickets](docs/engineering/stage1-implementation-tickets.md)和[工程评审闭合记录](docs/engineering/plan-eng-review-closure.md)为准。
- 已生成架构探针总计划：[architecture-probes-plan.md](docs/engineering/architecture-probes-plan.md)。
- 已固化复审后的协议语义收敛：[ADR-0036](docs/adr/0036-stage1-protocol-clarifications.md)，涉及逐文档授权扩展点（阶段 1 预留不实现）、quick_parse 临时引用（纳入实现）、ModelAdapter 调用上下文、Pipeline/Release 关系、Evidence/Answer 快照归属、CONFLICT Finalizer 门禁、Redis 故障降级和 T1 拆分。
- 已生成 PROBE-000 环境门禁和 6 张探针 Tickets：[docs/engineering/tickets/](docs/engineering/tickets/)。
- 已执行并复检 PROBE-000 环境门禁：用户 WSL 终端确认 Node/pnpm/Python/curl/jq、Docker CE CLI、Docker Engine、Compose 和 Socket 全部通过；Docker Engine 当前可见内存为 23.47 GiB，超过日常 22 GiB，略低于 Parser 建议 24 GiB，因此门禁结论为 `PASS_WITH_ADJUSTMENT`。
- 已完成 PROBE-001 Keycloak/OIDC 实测并取得 `PASS`：PKCE、JWKS、过期与撤权、禁用后 refresh、不可用 fail closed 和恢复均通过。
- 已完成 PROBE-002 DeepDOC 实测并取得 `PASS`：使用真实 `infinity-sdk==0.7.3` tokenizer 与 `punkt_tab`，四类 PDF 的原文定位率均为 1.0，峰值 RSS 1111.7 MiB；Parser/Worker 服务层生命周期仍按原 Ticket 在集成阶段复测。
- 已完成 PROBE-003/004 实测并取得 `PASS`：OpenSearch 的分区、Alias、过滤和回滚路径成立；RabbitMQ 的 TTL+DLX、取消、DLQ、重放和 quarantine 语义成立。
- 已完成 PROBE-005/006 实测并取得 `PASS_WITH_ADJUSTMENT`：模型三腿供应商基线已定档；真实小规模 Recall@5 冻结 `wide-1024` 和 `parent_child=false`。
- 已完成 /autoplan 架构评审（CEO + 技术先进性双轴）并按"个人学习项目、技术完整性与先进性优先"的前提裁决：6 项纯技术发现保留（2 Critical），商业类发现作废；多模态被确认为最大先进性缺口，[ADR-0038](docs/adr/0038-vlm-parser-backend-and-multimodal-scope.md) 将 Parser 扩展为多后端（DeepDOC/Office 混合/图片 OCR），图片走本地 DeepDOC OCR、Office 走格式库提取，**解析链路零云调用**，VLM 后置为阶段 2 可选增强槽位；T4 拆为 T4a/T4b，新增 PROBE-007 本地探针（零云成本）。
- 已完成 /gstack-plan-eng-review 对 ADR-0038 设计的增量评审（2026-08-28）：8 项发现（D1 契约一次定形、D2 未列出格式显式拒绝、D3 全异步无例外、D4 自行移植不依赖 ragflow、D5 补管线图、D6/D7/D8 探针补强）全部决议并落文档，报告附于 ADR-0038 末尾；0 critical gap，ENG CLEARED——devex 评审当时"NOT CLEARED（无 7 天内 Eng Review）"的门由此关闭，T1a 开工前无需再跑。/plan-devex-review（2026-08-28，score 5→6，TTHW 目标 <2 min）报告已由用户提供原文并[落盘](docs/engineering/plan-devex-review-20260828.md)，其 P1 三项（.env 预载+README 黄金路径、环境预检脚本、API 错误信封+全局异常过滤器）并入 T1a；T1a 合并后 boomerang 复测。
- 已完成 StepFun `step-3.5-flash-2603` 的契约探针和 `reasoning_effort=low/high` A/B：两轮各 20 个有效样本合并后，`low` 完整生成 p50 2.05 s、p95 3.752 s、最大 6.969 s，答案与 D1/D2 引用正确率 1.0；因 p95 略超 3.5 s，暂不替换 ADR-0017 的 fluxionai Chat 基线，也不再继续扩大模型探索。
- 已完成 **T1a Manifest/Prisma Core 切片 + devex P1 三项**（2026-08-28，已提交于 `bc99b0a`）：10 个领域模型与仓库首份迁移、内容寻址 contentHash（规范化 JSON + SHA-256）与四条兼容矩阵纯函数、`POST /manifests/{ingestion,retrieval,answer,pipelines}`（含 `/:id/approve`）与 `POST /releases`/`GET /releases/:id` 领域命令端点、DX-T1 `.env` 预载、DX-T2 `preflight`、DX-T3 五字段错误信封与全局异常过滤器。`pnpm run verify` 全绿（15 文件 / 106 测试），黄金路径 `infra:up → bootstrap → api dev → /health/ready` 六项全 `up` 真实实测通过，T1a HTTP 面逐条实测（幂等重放同 id、422 兼容违规、400/404 信封）。同时修复 T0 遗留缺陷：dev 入口用 `tsx`（esbuild 不产出 `emitDecoratorMetadata`）导致 NestJS 注入为 `undefined`、所有请求 500，已改 `nodemon + ts-node` 并加配置不变量测试（期间曾短暂改用 `node --watch`，因它在 Linux 按 inode 监听、原子保存后热重载只生效一次而回退，实测记录见 CHANGELOG）。验收记录：[HG-01 T1a 切片](docs/engineering/acceptance/hg-01-t1a-manifest-core.md)（2026-09-01 用户结论 `ACCEPTED_WITH_ACTIONS`）。
- 已按 [ADR-0039](docs/adr/0039-business-identity-and-unified-authorization.md) 收口 T14 范围（2026-08-31）：外部身份与业务用户分离、能力权限与资源策略分两层、业务主体多租户/多 Workspace/多角色、租户上下文只从已验证身份推导；组织结构、临时直接赋权与非文档型资源域列为已识别扩展点，阶段 1 不建表。T14 估算随之上调为 human ~8d / CC ~2d，2026-08-27 的十八张票据估算冻结到此结束。
- 已完成 **T1a 代码评审 9 项修复**（2026-08-31，已提交于 `1b2a2ed`）：`ERROR_STATUS` 成为错误码唯一事实源并补 401/403/405/413/415（此前 T14 的 guard 抛 401 会变成 500 `INTERNAL_ERROR`）、`approve` 的状态判定下推为 `UPDATE ... WHERE status='DRAFT'` 消除并发竞态、`checkPipelineToRelease` 从死代码恢复为真判定、`readVectorChannels` 不再无检查断言元素形状、种子 `parseBackend` 显式写入并接入 typecheck、preflight 的 uv 从阻断降为警告、dev 脚本补回跨包 `dist` 热重载。`pnpm run verify` 全绿（15 文件 / 122 测试）。第 10 项（approve/`GET /releases/:id` 缺 `tenantId` 谓词）按裁决归入 [T14 DoD](docs/engineering/tickets/T14-identity-authorization.md#dod)，理由是当前 `tenantId` 只来自请求体、加谓词不构成隔离。
- 已完成 **/plan-devex-review boomerang 复测**（2026-09-01）：先落 `scripts/dx-baseline.sh`（`pnpm run dx:baseline`，devex T6）把 DX 口径脚本化，再在 `1b2a2ed` 上复测四次——TTHW（`infra:up` + `bootstrap` + `/health/ready` 200）7.3–11.0s、verify 17.0–22.5s，两个退场条件（TTHW <2 min、verify <20 s）达成；总体 DX 6/10 → 8/10，状态 CLEARED WITH MINOR CONCERNS。报告：[boomerang 复测](docs/engineering/plan-devex-review-20260901-boomerang.md)。剩余 concerns：devex T5（CONTRIBUTING）、T7（worker 单命令）未做，CI 从未真实运行（无 git 远端，用户动作），冷启动 TTHW 未测（`--cold` 会删本地开发库，需显式 `--yes-destroy-data`）。verify 在缓存冷时 22.5s 超目标 12%，是否设门禁与如何放宽口径留给用户裁决。
- 已建立 **CI/CD + 质量检测 + 日志检测流水线**（2026-09-01 建立，2026-09-02 经三轮真跑
  与两轮主动审计定型）：五条 GitHub Actions
  工作流——`ci.yml`（node / quality / python / compose 四 job，quality 含 shellcheck
  `--strict`、工作流 YAML 静态检查、Markdown 链接、提交信息规范、覆盖率棘轮 86/81/82/86
  与增量覆盖率 80%；compose 含 Parser 镜像构建并真起一次）、`integration.yml`
  （真起六容器 → `bootstrap` 跑两遍验幂等 → 编译产物起进程 → `smoke:api`）、
  `security.yml`（gitleaks 扫所有引用可达的提交 + `pnpm audit` critical 阻断 + PR 依赖/
  许可证审查；**"全历史"这句话 2026-09-02 之前不成立**，见下）、
  `codeql.yml`（TS+Python，暂不设 required）、`release.yml`（`v*` 标签 → 重跑 verify +
  标签↔CHANGELOG 对齐 → Parser 镜像进 GHCR 带 provenance/SBOM → GitHub Release）。
  配套 `dependabot.yml`（uv 生态显式忽略 `xgboost >=3.1`，理由是 PROBE-002 的二进制模型）、
  `CODEOWNERS`、PR 模板、`.gitleaks.toml`。日志检测落在 `scripts/smoke-api.sh`
  （`pnpm run smoke:api`，31 项断言实测全通过）：编译产物真起进程打真实 HTTP，断言 T1a
  端点与五字段信封、内容寻址幂等、`traceparent` 严格校验、响应体无堆栈，再断言进程
  stdout 每行都是带 `level/time/service` 的 JSON、存在 `nest:true` 行、`.env` 的七个
  口令/密钥与 `DATABASE_URL` 口令均未出现。**期间修掉一条真实泄漏通路**：NestJS 框架
  日志原走 `ConsoleLogger` 纯文本，绕过 `@rag/observability` 的 redact，已装
  `NestPinoLogger` 接入 pino；`GlobalExceptionFilter` 改为可注入 logger，使
  「`INTERNAL_ERROR` 的 `trace_id` 能反查到那条日志」从声明变成被断言的事实。
  `pnpm run verify` 全绿（16 文件 / 129 测试）。流水线全貌、需在 GitHub 页面手工点的
  分支保护设置与明确不做的事：[CI/CD 与质量·日志检测](docs/engineering/ci-cd.md)。
  **两轮主动审计的共同结论是"绿也要看是怎么绿的"**：第四轮发现 `check:commits` 在十次
  运行里检查了 0 条提交（`origin/main == HEAD`，区间恒空）、`release.yml` 从未执行过因而
  一推标签就死在 `uv: command not found`；第五轮发现名为「全历史密钥扫描」的 required
  check 日志里写着 `INF 2 commits scanned.`——`gitleaks/gitleaks-action` 按事件名自行收窄
  范围，全历史一次都没扫过，同一个 action 在 PR 上还因缺 `pull-requests` 权限永远红。
  修的过程中又撞到第三个同形状的：`.gitignore` 里刻意宽的 `*secret*` 把新脚本
  `scripts/check-secrets.sh` 一起忽略了，而 `check-shell.sh` 用 `git ls-files` 枚举脚本、
  **看不见被忽略的文件**——加例外前 26 个、加后 27 个，此前所有"shellcheck 通过"都不含它。
  修完还差点埋一颗新雷：`check:secrets` 串进 `verify` 后，`release.yml` 的 guard（浅克隆）
  会在它上面失败——第一次推 `v*` 标签的死因只是从 `uv` 换成"浅克隆"。这条已补
  `fetch-depth: 0`，并**写成机械检查而不是文档**：工作流基线层第 5 条规则要求跑
  `check:secrets` / `check:commits` / `verify` 的 job 必须显式写 `fetch-depth: 0`。
  五项都是"绿着的"或"红在没人看的地方"，没有一个是靠看红叉发现的。gitleaks 现已改为
  `scripts/check-secrets.sh` 直接调钉死版本的二进制（v8.30.1 + 三平台 sha256），三种事件
  同一条命令。详见 ci-cd.md §6.4 / §6.5。

## 尚未完成且不能假装完成

- T0 工程骨架与 T1a 切片（Manifest/Release 领域模型、内容寻址、兼容矩阵、领域命令端点）已提交于 `bc99b0a`；同一批次的 T14 身份与授权、T11 同步审计、T12 预算 Ledger 骨架未开始，`tenantId` 目前由请求体携带，只能在本地开发环境使用。T14 的计划已按 [ADR-0039](docs/adr/0039-business-identity-and-unified-authorization.md) 明确为“Keycloak/OIDC 身份 + 自有 BusinessUser/租户/Workspace/角色/能力权限 + 资源 ACL”，后续客服、研发、普通员工三个角色工作台复用该身份上下文，不复制用户体系。T1b 分块、Release 状态迁移（`BUILDING` 及之后属 T5）、消息、检索、回答和 UI 仍未开始。
- Node 的格式、Lint、类型检查、构建、Prisma schema 校验、Python uv/pytest、Compose 配置解析和初始化脚本语法检查已在当前环境执行；六个 core 容器 healthy 与 `/health/ready` 已在 T0/T1a 真实实测通过，容器级集成测试（Testcontainers）、Playwright 和部署仍未验证。
- 尚无真实业务语料的完整混合检索、Rerank 后质量、生产 ACL/有效期/删除过滤链和 50 题业务回归基线；1024 维相对原生 4096 维也没有同语料对照，不能宣称无召回损失。
- `rerankInputSize` 正式值尚未拍板；T1a 开发种子使用 N=64，T6 必须用真实业务语料比较质量、延迟和成本后再冻结。
- ModelAdapter 数据分级门禁和 PostgreSQL Budget Ledger、Parser/Worker 生命周期、AMQP Publisher Confirm/prefetch 仍是实现集成条件，不能把探针结论当成业务实现证据。
- fluxionai 承载模型映射、OpenRouter/fluxionai 数据留存与合规评估尚未完成；在关闭前只允许合成或严格脱敏数据进入云路径。
- 每日 16 元、用户级配额和 24 至 36 周窗口仍需在真实链路下校准；票据级工作量估算已补齐，但周期换算系数尚未用真实交付速率验证。完整 24 GiB Parser 余量也尚未验证。
- 探针收尾改动已于 2026-08-27 在 `chore/probe-closeout` 分支按主题切分提交（gitignore、探针脚本、探针结果与归档、ADR、决策门与探针票据、实施票据、评审记录、顶层状态、归档脱敏补齐、票据工作量估算），工作区干净，T0 的收尾提交前置条件已满足。该分支已于 2026-08-27 以 fast-forward 合并回 `main`（`main` 为 `a626cf9`），仓库仍无远程。
- **CI 已首跑（2026-09-02）**：远端换成 SSH（`git@github.com:Axwen/myRAG.git`）后推送成功，
  `gh` 已装并登录。首轮四条工作流全红，其中只有一个是流水线自己的配置错
  （`astral-sh/setup-uv@v10` 这个浮动大版本标签不存在），另外三个是仓库里真实存在、
  本地永远不复现的缺陷：全新克隆上 `bootstrap` 的 seed 必失败（`packages/*/dist` 未构建）、
  `PROJECT_STATE.md` 指向 gitignore 目录的死链、`security.yml` 的 audit job 缺 `.env` 导致
  `prisma generate` 报 `PrismaConfigEnvError`。已全部修复，记录见
  [CI/CD 文档](docs/engineering/ci-cd.md) §6。
  第二轮复跑后 `Integration`、`Security` 转绿、CodeQL 如期变灰，只剩 `quality` 红在覆盖率：
  跨包 import 解析到 `dist`，未构建时 6 个测试文件加载失败、129 个测试静默只剩 80 个
  （首轮该 job 死在 `check:links`、没走到这一步；`node` job 一直绿是因为它的 `typecheck`
  就是会 emit 的 `tsc -b`）。已在覆盖率前补构建步骤，并由 `vitest.config.ts` 校验入口存在。
  第三轮（`3610daa`）**四条工作流全绿**：`node` 81s、`quality` 51s、`python` 11s、
  `compose` 22s、`smoke` 183s、`gitleaks` 10s、`pnpm audit` 29s，覆盖率报告作为 artifact
  上传（115 KB）。分支保护要的六个 required check 至此都绿过一次，名字能在网页上搜到。
  `analyze`（CodeQL）与 `dependency-review` 在本仓库都无法启用——private repo 要
  Code Security / Advanced Security，而那是面向组织与企业的产品，个人账号下的 private
  repo 买不到；两者已按同一个仓库变量 `ADVANCED_SECURITY_ENABLED` 关掉（skip 是灰色，
  不是永远红的检查），唯一确定可行的启用路径是把仓库设为 public。
  **第四轮是全绿之后的主动审计**（2026-09-02，见
  [CI/CD 文档](docs/engineering/ci-cd.md) §6.4），找的是"跑过的步骤都对"证明不了的两类
  盲区，九项改动含两个 P0：`check:commits` 因 `actions/checkout` 在 push 到 main 时把本地
  `main` 指到 `origin/main`、`origin/main..HEAD` 恒为空，**十次运行里检查了 0 条提交**；
  `release.yml` 的 guard 重跑 verify 会死在 `uv: command not found`（runner 不预装 uv），
  同一文件的手动派发还会检出默认分支而不是要发布的标签。另七项：17 处 `uses:` 由浮动 tag
  改钉 40 位 SHA、`security.yml`/`codeql.yml` 的 concurrency 补事件名（否则周一定时扫被
  同时段 push 取消）、`integration.yml` 补周扫、新增工作流 YAML 检查 / 增量覆盖率 /
  Parser 镜像启动验证三条门禁。新增的工作流基线检查当场抓到本批改动自己的一个错——
  `ci.yml` 里步骤名含裸的 `run:` 加空格，YAML 会把它当映射键，整个文件不可解析、四个 job
  一个都不会跑。**`release.yml` 仍是最大未验证面**：三个 P0 里两个在它身上，而它至今
  0 个标签、0 次运行；真验证需要推一个一次性 `v0.0.1-rc.1` 预发布并对外产出 GHCR 包与
  GitHub Release，属需单独决定的动作。
- `~/.gstack` 评审日志持久化曾因审批服务 503 失败；项目内文档和 JSONL 是当前可靠副本。

## 当前阶段：T0 已收口，进入第一批业务票据

探针阶段已完成外部事实验证。探针代码可丢弃，只用于复跑证据，不建立第二条产品主链。

探针状态：

| 探针 | 主题 | 状态 | 结果 |
|---|---|---|---|
| PROBE-000 | 本地工具链与 Docker CE 环境门禁 | PASS_WITH_ADJUSTMENT | Engine/Compose/Socket 通过；Engine 内存 23.47 GiB，超过日常 22 GiB，略低于 Parser 建议 24 GiB |
| PROBE-001 | Keycloak/OIDC、Token、撤权、不可用恢复 | PASS | 6 项全通过：PKCE 登录、JWKS 2 键、subject 稳定映射、过期 401、撤权 401（传播 ~70 ms）、禁用后 refresh 400、不可用 fail closed（userinfo 502）并恢复 |
| PROBE-002 | RAGFlow DeepDOC、ParseArtifact、资源和定位质量 | PASS | 真实 `infinity-sdk==0.7.3` tokenizer；四类 PDF 原文定位率 1.0，峰值 RSS 1111.7 MiB；服务层生命周期仍待 Worker/Parser 集成复测 |
| PROBE-003 | OpenSearch、Alias、`acl_scope_key`、kNN 参数、带过滤召回、回滚和查询预算 | PASS | 9 项校验全通过：维度/engine 拒绝、分区隔离、mapping 有 `acl_scope_key` 且无 `acl_subject_ids`/`acl_revision`、Alias 原子切换+回滚、Intent/Reconciler 纠偏、删除/Legal Hold/过期激活守卫；kNN 暂定 lucene/hnsw m=16 ef_c=128 ef_s=512（1500 合成向量，真实业务规模与过滤近似路径仍待回归）|
| PROBE-004 | RabbitMQ、Retry、Cancel、DLQ、Replay | PASS | 8 项校验全通过：routed 确认 + 不可路由检出、幂等 Relay effect-once、TTL+DLX 延迟重试(x-death `expired` 关联)、执行前取消零副作用、永久错误 DLQ(x-death `rejected`@`perm.q` 关联)、quarantine 不无限 requeue、replay 生成新 Generation 并保留死信链;broker 原语经 management HTTP API 实测,Publisher Confirm/prefetch 属线级特性待 Worker 集成测试复测 |
| PROBE-005 | 云模型 ModelAdapter、Chat/Embedding/Reranker/引用验证、预算账本、真实延迟与费用 | PASS_WITH_ADJUSTMENT | Embedding=OpenRouter `qwen/qwen3-embedding-8b`（1024 维）、Chat/高风险蕴含=fluxionai `gpt-5.6-terra` Responses、Reranker=OpenRouter `qwen/qwen3-reranker-8b` 均已实测；当前调整项为 `rerankInputSize` 产品取舍、Adapter 侧上限/429/结构化输出防护，以及预算账本、数据门禁和供应商治理的实现级收口。详见 PROBE-005 Ticket 与结果索引 |
| PROBE-006 | 分块参数与引用定位，冻结 `ChunkingManifest` | PASS_WITH_ADJUSTMENT | 真实 tokenizer + OpenRouter Embedding + OpenSearch；5 份 ParseArtifact、6 题黄金子集上 `wide-1024` Recall@5=1.0、引用可定位率=1.0、截断率=0；parent-child Recall@5=0.6667，阶段 1 不启用 parent-child。该结果是小规模纯 kNN 冻结依据，不是完整混合检索或生产 ACL 链路基线 |

PROBE-000 是门禁而不是架构假设验证，不计入六个探针。资源 `PASS_WITH_ADJUSTMENT` 不阻断六个探针，但 DeepDOC/分块报告必须标注 23.47 GiB profile；PROBE-002 与 PROBE-006 已完成。六个探针的外部事实门已完成；整体仍有三类收口项：`rerankInputSize` 产品取舍、服务层集成验证（预算账本、数据门禁、Parser/Worker/AMQP）和生产真实数据治理。逐项状态见 [Probe Decision Gate](docs/engineering/probe-decision-gate.md)。

决策门：六个探针已全部为 `PASS` 或 `PASS_WITH_ADJUSTMENT`，外部事实门已通过；T0、T1a/T1b、T2-T16 按 [Probe Decision Gate](docs/engineering/probe-decision-gate.md) 逐项关闭实现集成和生产治理条件。任一后续复测为 `BLOCKED` 时暂停受影响模块的实现。

## 下一步执行顺序

1. **已完成**：探针收尾提交已在 `chore/probe-closeout` 分支按主题切分；提交前已校验无凭证残留、无供应商注入提示词正文入库、全部 JSON 合法、Markdown 相对链接零断裂，工作区干净。T0/T14/T15/T16 的工作量估算也已补齐，十八张票据的估算与周期换算见[工程评审闭合记录第 16.1 节](docs/engineering/plan-eng-review-closure.md)。该分支已 fast-forward 合并回 `main`，探针收尾阶段结束。
2. **已完成（2026-08-28）**：[T0 Monorepo 基线](docs/engineering/tickets/T0-monorepo-foundation.md) 在真实环境完成验收——九步 verify 全链（64 Vitest + 5 pytest）通过，六个 core 服务 healthy，`infra:down/up` 干净往返，`bootstrap` 重复执行零重复副作用，停止 Redis 后 API `/health/ready` 诚实 503 并给出依赖级原因。实现与评审记录：[T0 代码评审](docs/engineering/t0-code-review-20260828.md)（含 RabbitMQ 健康检查参数错误的修复）、[T0 DX Review 与实现准备增量复审](docs/engineering/t0-dx-review-20260828.md)。
3. **已完成（2026-08-28）**：DX Review 与实现准备增量复审已执行——真实工具链与依赖图确认，T0 估算（CC ~1d）与实际吻合。十八张票估算当时维持冻结；该冻结已于 2026-08-31 因 ADR-0039 扩大 T14 范围而结束（T14 ~6d → ~8d，合计 86.5d / 21.1d），后续范围变更同样按“改范围就改估算”处理。
4. **进行中**：按[阶段 1 实施 Tickets](docs/engineering/stage1-implementation-tickets.md)推进 T1a + T14 + T11(同步审计) + T12(Ledger 骨架)。**T1a 切片与并入的 devex P1 三项（DX-T1/DX-T2/DX-T3）已提交为 `bc99b0a` + `1b2a2ed`，并于 2026-09-01 获用户 `ACCEPTED_WITH_ACTIONS`**（[验收记录 §6](docs/engineering/acceptance/hg-01-t1a-manifest-core.md#6-用户验收结论)：租户谓词与请求体 `tenantId` 退场归 [T14 DoD](docs/engineering/tickets/T14-identity-authorization.md#dod)，幂等重放 201→200 归 T2）。该结论只覆盖 T1a 切片，**不等于 HG-01 门禁通过**，也不授权 commit/push/PR/merge/部署。
   同批次剩余按依赖顺序推进：**T12 Ledger/配置骨架 → T11 同步审计骨架 → T14a（Keycloak auth + 7 张身份表与迁移）→ T14b（统一授权入口、能力权限、资源策略、`acl_scope_key` 编译、fail closed）**；T11 必须先于 T14b，因为 T14 DoD 要求授权决策写同步领域审计。T14 按 [ADR-0039](docs/adr/0039-business-identity-and-unified-authorization.md) 实现，票据要求身份迁移与授权代码分开提交、分开评审，故 T14a 结束时增设一个临时人工门禁（[门禁文档](docs/engineering/manual-acceptance-gate.md)允许对过大批次或安全边界决策加设临时门禁）。四项全部完成后才是完整 HG-01 核验，通过后方可启动 T2/T10/T3/T1b。
   **前置待用户动作**：远端已换成 SSH（`git@github.com:Axwen/myRAG.git`）并推送成功，CI 已于 2026-09-02 跑通——首轮四条工作流全红，三轮共抓到五个本地永不复现的真缺陷（全新克隆上 `bootstrap` 必失败、文档死链、audit job 缺 `.env`、单测依赖未构建的 `packages/*/dist`，外加配置错 `setup-uv@v10` 不存在），已全部修复，第三轮四条工作流全绿，留档于 [CI/CD 文档](docs/engineering/ci-cd.md) §6；CodeQL 与 dependency-review 因 private repo 缺 Code Security 一起改为按仓库变量 `ADVANCED_SECURITY_ENABLED` 开关，默认 skip。第四轮为全绿后的主动审计，九项改动含两个 P0（`check:commits` 十次运行检查了 0 条提交、`release.yml` 第一次推标签会死在缺 uv 上），见 §6.4。**剩余待用户动作**：按 CI/CD 文档 §3 在网页上设分支保护与 required checks（`quality` 与 `compose` 第四轮改过名，改名后的名字要等这一轮跑完才出现在选择器里，老名字要手动去掉），处理三个 Dependabot PR（都需先 rebase 到修复后的 main 才有可信信号；其中 actions 分组那个 PR 会把 `uses:` 换回浮动 tag，现在会被工作流基线检查当场拦下，需逐条改成钉 SHA 的形式），并决定要不要为了 CodeQL / dependency-review 把仓库设为 public。/plan-devex-review boomerang 已于 2026-09-01 跑完（dx-baseline 脚本已落，两个目标达成，见 [复测报告](docs/engineering/plan-devex-review-20260901-boomerang.md)）；verify 门禁阈值暂不设定，待 CI 有真实分布后再定；devex T5/T7 仍未做，低优先级自由安排。后续每个实施批次都按 HG-02 至 HG-07 停顿并等待人工结论。
5. 各模块按 [Probe Decision Gate](docs/engineering/probe-decision-gate.md) 关闭实现与生产治理门槛；集成项全部关闭后，再进行完整增量工程复审和 24 至 36 周窗口重估。

## 详细文档入口

- 领域术语：[CONTEXT.md](CONTEXT.md)
- 产品与架构边界：[docs/design/企业级可信RAG基础MVP-产品与架构边界.md](docs/design/企业级可信RAG基础MVP-产品与架构边界.md)
- 工程评审闭合记录：[docs/engineering/plan-eng-review-closure.md](docs/engineering/plan-eng-review-closure.md)
- 工程评审测试计划：[docs/engineering/plan-eng-review-test-plan.md](docs/engineering/plan-eng-review-test-plan.md)
- 架构探针总计划：[docs/engineering/architecture-probes-plan.md](docs/engineering/architecture-probes-plan.md)
- 设计复审修复记录：[docs/engineering/design-fix-log-20260824.md](docs/engineering/design-fix-log-20260824.md)
- CI/CD 与质量·日志检测流水线：[docs/engineering/ci-cd.md](docs/engineering/ci-cd.md)
- 安全评审专用清单（实现阶段 T1a–T16 专用，出现业务代码后启用）：[docs/engineering/security-review-checklist.md](docs/engineering/security-review-checklist.md)
- 阶段人工核验门禁（并行 Agent 收口、UI/代码/验证材料和用户签字规则）：[docs/engineering/manual-acceptance-gate.md](docs/engineering/manual-acceptance-gate.md)
- 架构图：[diagrams/ts-rag-architecture.mmd](diagrams/ts-rag-architecture.mmd)
- 探针 Tickets：[docs/engineering/tickets/](docs/engineering/tickets/)
- 当前实施 Tickets：[docs/engineering/stage1-implementation-tickets.md](docs/engineering/stage1-implementation-tickets.md)
- 历史评审任务快照：[docs/engineering/tasks-eng-review-20260824.jsonl](docs/engineering/tasks-eng-review-20260824.jsonl)
- TS 技术设计方案：[技术设计方案-TS企业级多模态RAG.md](技术设计方案-TS企业级多模态RAG.md)
- ADR 目录：[docs/adr/](docs/adr/)
- 参考仓库：[nageoffer/ragent](https://github.com/nageoffer/ragent)、[infiniflow/ragflow](https://github.com/infiniflow/ragflow)
  （只在本地留工作副本，`/references/` 已 gitignore、不随仓库分发；原先这里写的是
  `references/ragent/` 相对链接，本地能点开、克隆下来是死链，`check:links` 在 CI 首跑
  就抓到了）

## 新会话恢复规则

新会话按以下顺序恢复：

1. 读取本文件，确认当前状态、硬边界和下一步。
2. 读取 `CONTEXT.md`，获得领域术语和禁止混用的概念。
3. 根据当前任务读取对应 ADR、设计文档或工程评审章节，不要一次加载所有参考仓库。
4. 如果用户提出新架构方向，先检查是否与本文件的已确认决策冲突；冲突时明确指出并新增 ADR，不静默覆盖。
5. 如果开始实现，先更新本文件的“尚未完成”和“下一步执行顺序”，实现后再写验证结果。
