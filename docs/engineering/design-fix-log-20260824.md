# 设计复审修复记录 2026-08-24

> 输入：一次全仓设计复审提出的 17 项问题（12 项架构层面、5 项事实一致性与治理），外加 3 项明确遗漏。
> 输出：11 份新 ADR、1 张新探针 Ticket、2 张探针 Ticket 扩项，以及全部下游文档同步修订。
> 性质：本文只做“发现 → 结论 → 落点”的追溯映射，不重复各文档正文。冲突时以 ADR 和[产品与架构边界](../design/企业级可信RAG基础MVP-产品与架构边界.md)为准。
> 状态：历史修复日志。六个架构探针已完成外部事实验证；引用预算、云模型和分块参数已按实测更新，kNN 真实业务规模、服务层集成和生产治理遗留项见 [Probe Decision Gate](probe-decision-gate.md)。

## 一、架构层面的问题

### 1. ACL 去规范化进不可变 Release，但没有变更传播路径

- 结论：把授权事实从索引里拆走，改为两段判定。索引只保留稳定的 `acl_scope_key`；检索前由 PostgreSQL 把主体编译为允许作用域集合作为过滤条件，候选合并后再对候选 `document_version_id` 集合做一次批量 PostgreSQL 权威复核，覆盖文档级拒绝例外、删除墓碑、Legal Hold 和有效期。`aclRevision` 退化为只失效 Redis 作用域缓存，不写入索引。PostgreSQL 不可用或复核超时时整个查询 fail closed。逐文档正向授权是加法、只能进预过滤，作为已识别扩展点预留但阶段 1 不实现，当前协议见 [ADR-0036](../adr/0036-stage1-protocol-clarifications.md)。
- 落点：[ADR-0026](../adr/0026-acl-scope-key-and-authoritative-recheck.md)；技术设计方案 §6.1、§7.3、§7.4 mapping（删除 `acl_subject_ids`、`acl_revision`、`index_scope`）、§10 回答数据流第 5 步；闭合记录 §3、§13 F-08/F-20、§14；边界文档术语表新增“ACL 作用域键”“候选权威复核”；PROBE-003 必须验证项 4。

### 2. kNN 引擎、参数和过滤语义未定

- 结论：engine、method 与 `m`/`ef_construction`/`ef_search` 由探针实测冻结，并单独承认带过滤 kNN 的召回衰减和堆外内存。
- 落点：[PROBE-003 Ticket](tickets/PROBE-003-opensearch-release.md) 必须验证项从 6 项增至 8 项，新增 kNN engine/参数选型（`lucene` 与 `faiss` 对照）、带过滤召回衰减、JVM 堆内与堆外 native 峰值分别记录；`BLOCKED` 判定新增“带过滤 kNN 召回衰减导致 Recall@5 不可达”；闭合记录 §14 资源表 OpenSearch 行补堆外与冻结参数；边界文档 §17 探针 3 说明。

### 3. 引用验证 200 ms 预算与验证内容自相矛盾

- 结论：改为分层预算。常规路径为句切分 + token 重叠 + 一次批量逐句 Embedding，P95 ≤ 600 ms；高风险路径追加一次 LLM 蕴含调用，P95 ≤ 1.5 s，且高风险正文在验证通过前不外发，缓冲上限 2,048 output tokens。蕴含与逐句 Embedding 费用显式并入“单次 ≤ 5 元”口径。
- 落点：[ADR-0027](../adr/0027-tiered-citation-verification-budget.md)；技术设计方案 §6.4；闭合记录 §9.2、§14 性能表；测试计划性能报告分列两档；PROBE-005 新增必须验证项 7（600 ms / 1.5 s 真实可达性）。
- **后续（2026-08-26，PROBE-005 实测）**：分层结构成立，但两个数值均不可达，已在 ADR-0027 内原地修订为常规 **P95 ≤ 2.0 s**、高风险 **P95 ≤ 3.5 s**，并新增「逐句 Embedding 与蕴含调用必须并发发起」硬约束。本条上文的 600 ms / 1.5 s 是 2026-08-24 当时的决策记录，已被取代。

### 4. 费用三个上限互不相容，预扣没有原子性载体

- 结论：每日上限由 20 元改为 16 元（16 × 31 = 496 ≤ 500，三个上限自洽）；预扣载体是 PostgreSQL `model_budget_ledger`，事务内 CAS 写 `RESERVED` 并带 lease，超限在任何供应商请求之前拒绝，结算写实际用量并释放差额，流式取消按已产出 token 结算，进程被 SIGKILL 后由 lease 过期回收。Redis 只缓存剩余额度用于展示和快速拒绝。
- 落点：[ADR-0029](../adr/0029-model-budget-ledger-and-limits.md)；技术设计方案 §10 第 7 步与路线图资源行；闭合记录 §14；边界文档 §16.2 与术语表“预算账本”；测试计划费用门禁与 SIGKILL lease 回收用例；PROBE-005 必须验证项 6 重写为账本全生命周期、新增项 8（一次典型高风险问答的真实总费用）。
- **后续（2026-08-26，PROBE-005 Stage C 实测）**：三个上限数值仍自洽、不变，但成本构成被实测改写并已在 ADR-0029 内原地补充：(a) 结算口径优先取供应商直接返回的 `usage.cost`，本地价目表退为预扣估值与回退，汇率单独记录；(b) **rerank 是单次问答里最大的单项**（1024 候选 ¥0.1587），`rerankInputSize` 因此是预算参数，已作为必填字段加入 `RetrievalManifest`（闭合记录 §4.2），其默认值待用户拍板；(c)「已计费但无结果」分两类——429 不返回任何 `usage` 属零成本拒绝可自由重试，客户端超时/挂起则可能上游已计费，预扣不得直接释放，须留给对账或 lease 过期处置。

### 5. Embedding 版本迁移没有路径

- 结论：`IndexPartition` 唯一键补入 `embeddingVersion`，即 `(tenantId, knowledgeSpaceId, dataClass, indexSchemaVersion, embeddingVersion)`；换模型或换维度必然进入新分区，不原地改写旧分区。重建从不可变 `ParseArtifact` 与 `chunk_manifest` 出发，走候选 Release、校验、原子 Alias 切换，保留旧分区用于回滚，重建受预算门禁和每租户并发 1 约束。
- 落点：[ADR-0028](../adr/0028-embedding-version-partition-and-rebuild.md)；技术设计方案 §8.1 新增 `POST /api/v1/knowledge-spaces/:spaceId/rebuild` 与 `GET .../rebuild/:rebuildId` 及协议段落；闭合记录 §4.1、§4.2 `ReleaseManifest` 补 `embeddingVersion`；边界文档术语表 `IndexPartition`。

### 6. `answer_run_event` 保存正文，却不在保留表和删除目标里

- 结论：回答正文改为三层存储。PostgreSQL 只存元数据与载荷哈希，没有正文可删；Redis `run:{runId}:events` TTL 24 小时只作 SSE 续读窗；对象存储快照是唯一长期正文副本，保留 90 天。因此回答正文的删除目标只有对象存储快照和 Redis 前缀两处。
- 落点：[ADR-0030](../adr/0030-answer-body-storage-tiers.md)；技术设计方案 §7.2、§10 第 10 步；闭合记录 §8 保留表新增 4 行、§8.1 删除段落、§8.2 `FULL` 行补回答快照、§9.1 续读窗与快照回落；边界文档术语表“回答快照”。

### 7. MVP 页面清单缺删除治理台和运维台，路由命名两套

- 结论：`/admin/deletions`、`/admin/evaluations`、`/admin/operations` 三个控制台是硬 DoD，不是可选项；路由只保留两个命名层，工作台页面在顶层、治理控制台统一在 `/admin/*`；quick_parse 明确为 `/chat` 内的会话级临时资料面板，不单独占路由。
- 落点：技术设计方案 §5.2 页面清单、命名规则与 quick_parse 说明；测试计划受影响页面与路由整段替换旧的 `/workspaces/:workspaceId/...` 方案；边界文档 §16.3 把三个控制台列为硬 DoD。

### 8. 分块策略没有冻结，也没有对应探针

- 结论：阶段 1 的分块粒度、重叠、表格/条款处理和是否启用 parent-child 一律不预先决定，由新增探针在固定语料上实测后冻结 `ChunkingManifest` 默认值；探针可以否决 parent-child。
- 落点：[ADR-0031](../adr/0031-chunking-frozen-after-probe.md)；新增 [PROBE-006 Ticket](tickets/PROBE-006-chunking-citation-locating.md)（复用 PROBE-002 解析产物，六项必须验证，`BLOCKED` 阻塞 T1b/T5/T6 的正式索引实现，但不阻塞 T1a 基础契约）；探针计划 §2/§3.3/§4/§5；边界文档 §17 探针 6；功能报告 §5.5 与风险表相应行改为“由 PROBE-006 冻结”。

### 9. Prompt Injection 有控制项、无协议

- 结论：文档内容永远是数据不是指令；固定定界符加来源标记，系统指令、工具定义与权限上下文永远排在资料之前。检测在三处：解析产物入库静态扫描、候选进入生成上下文前的运行时检查、回答产出后的输出检查。状态字段 `injection_risk` 取 `none/suspected/blocked`；高密度命中资产置 `QUARANTINED` 并阻断发布；`suspected` 只作证据展示且回答降级为 `EVIDENCE_ONLY`，Top5 全部命中则 `REFUSED`。任何情况下不跟随文档内 URL、不执行文档内代码、不扩大工具白名单。
- 落点：[ADR-0032](../adr/0032-untrusted-content-and-prompt-injection.md)；技术设计方案 §7.4 mapping 补 `injection_risk`、§10 第 6 步、§11.2 安全条目、入库流程解析步骤；闭合记录 §10 quick_parse 表补注入检查行、§13 F-27；测试计划新增安全门禁段落与注入样本集用例；边界文档 §20 第 13 项。

### 10. 多空间证据冲突只有排序原则，没有确定性算法

- 结论：给出可测的确定性全序键：权威级别（`OFFICIAL` > `STANDARD_SCRIPT` > `TICKET_DERIVED`）→ 适用范围精确匹配数 → `valid_from` 新鲜度 → 版本创建时间 → `documentVersionId` 字典序。结果不得依赖知识空间遍历顺序。前两个键并列且结论不相容时判为 `CONFLICT`，同时展示双来源、不给单一结论，模型不裁决冲突。`valid_to` 过期证据不进生成上下文，只作 `EXPIRED` 提示。
- 落点：[ADR-0033](../adr/0033-deterministic-evidence-conflict-resolution.md)；技术设计方案 §6.4、§6.6；闭合记录 §4.2 `RetrievalSnapshot` 补 `conflictResolution`、§9.2 引用状态段落、§13 F-28、§16 T6 验证项；测试计划固定快照重复运行用例；边界文档术语表与 §20 第 11 项。

### 11. 只有租户级配额，没有用户级限流

- 结论：并发 AnswerRun 1、并发 SSE 2、提问 10 次/分钟与 200 次/日、上传 20 个/小时、重建并发 1/租户。用户级是 Redis 软闸，返回 `429` 与 `Retry-After`；租户预算仍是 PostgreSQL 硬闸。Redis 不可用时 fail open 并告警，因为硬闸仍在，最坏后果是预算烧得更快而不是越权。超限只允许排队或拒绝，不得跳过引用验证、缩小候选集或改变数据等级路由。
- 落点：[ADR-0034](../adr/0034-per-user-rate-limit-and-concurrency-quota.md)；技术设计方案 §11.2；闭合记录 §14 新增用户级配额行、§13 F-29、§16 T12 验证项；测试计划 `429` 用例；边界文档 §16.2 与术语表“用户级配额”。

### 12. 架构图滞后，且两条边绕过三段回答边界

- 结论：重画 [diagrams/ts-rag-architecture.mmd](../../diagrams/ts-rag-architecture.mmd)。新增 Keycloak、作用域编译、候选权威复核、全序消解、AnswerModule/CitationModule/AnswerFinalizer 三段、`worker:evaluation`、Cleanup Worker、DLQ 人工重放、Deletion Orchestrator 与 Legal Hold、quick_parse、`model_budget_ledger`；`ORCH --> MODEL` 与 `CIT --> MODEL` 改为按阶段各自持有的调用并标注用途，正文提交只经 `AnswerFinalizer`；观测层标注 `traceparent` 内建。

## 二、事实一致性与治理

### 13. 探针状态自相矛盾，PROBE-000 缺索引

- 结论：状态单点化。探针计划头部由 `READY_TO_RUN` 改为 `BLOCKED_ENVIRONMENT`，与正文一致；PROBE-000 进入 `PROJECT_STATE.md` 探针表和闭合记录 ticket 索引，并明确它是门禁而不是六个探针之一，但 `BLOCKED` 时其余探针一律不启动；探针数量全仓统一为六个。
- 落点：探针计划头部与 §2/§3.3/§4/§5；`PROJECT_STATE.md` 探针表、决策门与下一步顺序；闭合记录 §16 ticket 列表；PROBE-000 Ticket 文案。

### 14. 周期口径两套

- 结论：24 至 36 周弹性窗口是唯一事实源，功能报告的 16 至 24 周作废。
- 落点：边界文档 §17 明确声明自身为周期唯一事实源；功能报告 §11 阶段 1 标题改为“周期口径见设计边界文档”并加口径说明；`PROJECT_STATE.md` 同步。

### 15. ADR-0005 与阶段 1 载体不一致

- 结论：约束继续有效，执行载体改为 NestJS 内部 `ModelAdapter` 准入层，它同时是数据分级准入与预算预扣的唯一出口。ADR-0005 保留原文，只在 frontmatter 标记 `status: superseded` 与 `superseded-by`，正文加取代提示，不改写历史决策文本。
- 落点：[ADR-0025](../adr/0025-data-class-routing-enforcement-point.md)；[ADR-0005](../adr/0005-model-routing-by-data-classification.md) frontmatter 与提示段；技术设计方案 §11.2。

### 16. 一批硬协议只活在第 5 级事实源

- 结论：把两 Worker Profile 隔离、审计同步与遥测异步、两阶段上传与 `object_claim`、Answer/Citation/Finalizer 三段边界、资源与超时预算、quick_parse 临时产物边界整体提升为 ADR 级事实。内容不变，只提升批准层级：后续修改必须新增 ADR 并显式取代对应段落，闭合记录只能引用不能重定义。
- 落点：[ADR-0035](../adr/0035-stage1-runtime-protocol-ratification.md)；`PROJECT_STATE.md` 核心架构不变量对应条目加 ADR 引用。

### 17. Design Review 与 DX Review 未跑

- 结论：不改判为已完成，而是给两项 `NOT RUN` 绑定触发点：Design Review 最迟不晚于 `/chat` 与三个 `/admin/*` 控制台开工；DX Review 在仓库骨架、Compose Profile 和一键启动链建立之后、T3 之前；两项完成前不得声明 UI 或本地开发体验闭合。
- 落点：闭合记录 GSTACK REVIEW REPORT 表格后新增触发点段落。

## 三、明确的遗漏

### 18. Trace 与门禁环境不匹配

- 结论：`traceId`/`spanId` 生成是应用内建能力，W3C `traceparent` 贯穿 HTTP、SSE、Outbox 消息和领域审计，因此 P0 可追溯门禁不依赖常驻观测栈；`observability` Profile 仍可按需启动，只影响可视化与聚合。
- 落点：技术设计方案 §12.1 Trace 结构新增 `authorization.scope-compile` 与 `authorization.candidate-recheck` span，并新增内建生成段落；`PROJECT_STATE.md` 核心架构不变量。

### 19. 索引从事实源重建只有端点、无协议

- 结论：与第 5 项合并处理，见 ADR-0028 与技术设计方案 §8.1 重建协议段落，含前置校验、预算门禁和阶段 1 明确不承诺的部分。

### 20. 目录不在版本控制下

- 结论：`git init` 涉及 `.gitignore` 取舍：`references/ragflow/`、`references/ragent/` 自带 `.git`，另有 `pdf/` 目录与本地探针输出。经用户确认后已执行。
- 状态：**已处理（2026-08-25）。** 已 `git init`（分支 `main`）并建立初始文档基线提交；`.gitignore` 排除 `references/`（固定 commit 快照）、`pdf/`（学习素材）、`.gstack*` 本地工具状态、探针本地运行产物与机密文件模式。

## 四、遗留与后续

- 修订后已做一次全仓校验：51 份文档的相对链接全部可解析（曾修正 6 张探针 Ticket 中 15 条 `../adr/`、`../design/` 层级错误的链接）；`20 元`、`200 ms`、`acl_subject_ids`、`五个探针` 的剩余命中只存在于 ADR 的问题陈述、显式否定断言和 JSONL 快照说明中，属于应当保留的历史上下文。
- 已处理：`git init` 与 `.gitignore` 范围（第 20 项，2026-08-25 完成）。
- 已实测冻结：PROBE-003 的 kNN 初始参数与 PROBE-006 的 `wide-1024`/`parent_child=false`；它们仍需在真实业务规模和完整过滤链下回归。待实测校准：每日 16 元、用户级配额默认值和 24 至 36 周窗口重估。（引用验证预算已于 2026-08-26 由 PROBE-005 实测校准并冻结为 2.0 s / 3.5 s。）
- 待触发执行：Design Review、DX Review（第 17 项的两个触发点）。
- 复审后已补强并固化 ADR-0036：逐文档授权扩展点（阶段 1 预留不实现）、quick_parse `TEMPORARY` 引用、ModelAdapter 调用上下文、Pipeline/Release 关系、EvidenceSnapshot 删除目标、`CONFLICT` Finalizer 门禁、Redis 故障时的并发兜底，以及 T1a/T1b 拆分。逐文档授权与 quick_parse `TEMPORARY` 两点经用户确认：前者预留设计不实现，后者纳入实现。
- 收尾一致性检查发现 ModelAdapter 文字虽覆盖“引用验证调用”，TypeScript 接口却只有 Chat/Embedding/Reranker 三个方法，存在实现时绕过统一准入层的歧义。已新增 `verifyCitation(input, context)` 方法，并同步 ADR-0025、ADR-0017、PROBE-005、测试计划、闭合记录、项目状态、主技术方案和架构图；quick_parse 图示同步改为“临时候选/索引，不进入生产 Alias”。
- Failure Modes Registry 由 F-01 至 F-24 扩展为 F-01 至 F-29，新增 F-25 Release 内陈旧 ACL、F-26 lease 泄漏、F-27 注入、F-28 非确定性、F-29 单用户预算耗尽。**2026-08-26 再扩展至 F-30**：新增「云模型供应商限流（429）被当作契约裁决或排序结果」——PROBE-005 Stage C 的探针自身曾因未退避 429 而得出「`top_n` 不生效」的错误结论，也曾把撞上 429 的超额候选探测记成「供应商拒绝」（另一次运行返回 200，证明并无该上限）。
- 当时实施任务由 T1-T12 扩展为 T1a/T1b、T2-T13：新增 T13 不可信内容与三处注入检测；T1a 承载基础 Manifest/Prisma，T1b 承载依赖 PROBE-006 的 Chunk/Index Schema；T5 补知识空间重建、T6 补两段授权与全序消解、T7 补分层验证预算、T12 补用户级限流与预算账本熔断。探针收尾后又补充 T0、T14-T16，当前范围以 [阶段 1 实施 Tickets](stage1-implementation-tickets.md) 为准；`tasks-eng-review-20260824.jsonl` 只保留为旧 T1-T12 评审快照。
