# 工程评审测试计划

> 生成日期：2026-08-24  
> 对应设计：[企业级可信 RAG 基础 MVP 产品与架构边界](../design/企业级可信RAG基础MVP-产品与架构边界.md)  
> 评审记录：[工程评审闭合记录](./plan-eng-review-closure.md)

## 受影响页面与路由

- `/login`：OIDC 登录、会话过期、Keycloak 不可用时的错误和重试。
- `/chat`：客服提问、风险分级回答、SSE 增量、停止/重试、引用展开和复制草稿。
- `/knowledge`、`/knowledge/upload`、`/knowledge/:id`：知识空间列表、授权过滤、上传、重复完成和版本详情。
- `/review`：送审、驳回、发布、归档和审核历史。
- `/ingestion`、`/ingestion/:jobId`：解析、投影、Release 构建、重试、取消、DLQ 和重放状态。
- `/admin/users`：用户和工作台成员。
- `/admin/deletions`：删除请求、目标状态、Legal Hold、墓碑和删除证明。
- `/admin/evaluations`：黄金集运行、门禁报告、模型/Manifest 版本和成本。
- `/admin/operations`：Worker Profile、队列积压、预算熔断、删除阻断和恢复演练结果。

路由与技术设计方案第 5.2 节保持一致：工作台页面在顶层，管理与治理控制台统一在 `/admin/*` 下。

## 关键交互

- 上传相同内容两次，确认 `complete` 幂等且不会生成重复副作用。
- 上传恶意文件或解析质量不足的文件，确认进入隔离/失败状态而不是可发布状态。
- 文档送审、驳回、发布、归档，确认只有已发布且 Active Release 成员可检索。
- Alias 已切换但 PostgreSQL 写回失败，确认对账或回滚可恢复且 UI 不显示虚假“已发布”。
- 发送普通问题，确认草稿流式展示，最终快照包含句级引用验证结果。
- 发送高风险问题，确认验证前不发送事实正文，失败时只显示证据、拒答或升级建议。
- 断开 SSE 后以 `Last-Event-ID` 续读，确认 Redis 续读窗命中时增量继续、窗口过期时回落最终快照并给出明确提示，两条路径都不重复拼接正文。
- 点击引用、预览或下载，确认使用当前 ACL 再鉴权。
- 使用继承型作用域授权查询，确认过滤表达为 `acl_scope_key IN allowedScopeKeys`，候选仍经过 PostgreSQL 权威复核；逐文档正向授权阶段 1 不实现，仅回归验证预过滤编译保留了可追加加法子句的形状（不做端到端授权用例）。
- 撤销成员权限后重新查询，确认候选集在 PostgreSQL 权威复核阶段被拦下，无需等待索引重投影。
- 在同一 `RetrievalSnapshot` 上重复运行多知识空间冲突题，确认候选顺序与引用状态完全一致，且同权威同范围的不相容证据被判为 `CONFLICT` 并同时展示。
- 让含未解决 `CONFLICT` 的回答进入 `AnswerFinalizer`，确认不能提交为 `ANSWERED`，只能得到 `PARTIAL`、`EVIDENCE_ONLY` 或 `REFUSED`，并写入快照、事件和审计。
- 提交注入样本集中的文档并提问，确认命中内容不进入生成上下文、不触发外链或工具调用，回答降级为 `EVIDENCE_ONLY` 或 `REFUSED` 并写审计。
- 单用户超过并发 SSE、每分钟或每日提问上限，确认返回 `429` 与 `Retry-After`，且不因限流跳过引用验证或缩短候选集。
- 在预算预扣成功后强杀进程，确认 lease 过期回收把额度释放并写审计，不出现永久占用。
- 删除文档后查询旧 AnswerRun、旧 RetrievalSnapshot 和重放 DLQ，确认正文不可恢复且只显示墓碑。
- 对 Quick Parse 会话等待 TTL 到期，确认从 `FULL` 降级到 `METADATA_ONLY`/`EXPIRED` 的用户提示明确。
- 对 Quick Parse 产生的 `TEMPORARY` 引用执行会话内回跳、主动删除和 TTL 到期测试，确认清理后只保留墓碑/哈希，不再展示正文，也不进入正式 Release。
- 在 `evaluation` 高负载时提交 ingestion，确认两个 Profile 的队列、并发、内存和预算相互隔离。
- Keycloak 不可用、Token 过期或撤权后重试查询，确认 fail closed、错误可解释且恢复后重新校验。
- 临时对象过期、正式对象 promote 成功但 PG 事务失败，确认孤儿清扫、object_claim 和删除证明闭合。
- 删除中的 Release 尝试激活、回滚或 DLQ 重放，确认删除墓碑和 Legal Hold 校验优先于发布动作。
- 让 Citation 验证失败或 Finalizer 收到未验证正文，确认最终快照不会提交未验证事实句。
- 分别用 Chat、Embedding、Reranker 和引用验证调用测试 `ModelCallContext`，确认四类调用都经过同一个 `ModelAdapter` 入口，数据等级、执行区、预算预扣号、Trace 和取消信号由服务端提供，`UNKNOWN`/敏感数据不会进入云执行区。
- 删除回答时同时检查 AnswerRun 快照、EvidenceSnapshot 和 Redis 续读窗三个删除目标，任一目标未完成都保持 `fail closed`。
- 让审计库可用但 Telemetry/Trace 投递失败，确认领域状态提交成功、异步遥测可重试且不丢领域审计。

## 边界与失败场景

- Token 过期、工作台成员不存在、跨租户 ID、跨密级查询。
- 对象存储成功但 PostgreSQL 事务失败，或相反。
- Parser 崩溃、OCR 超时、表格告警、任务完成但响应丢失。
- RabbitMQ 重复投递、Publisher Confirm 丢失、Broker 暂时不可用、旧 Generation 迟到、未知 Schema、DLQ 人工重放。
- OpenSearch 超时、稀疏或向量一路为空、Alias 切换失败、Alias 已切 PG 未确认、smoke check 失败。
- 多知识空间证据冲突、有效期过期、撤权后候选复核竞态、无据问题、注入内容与零宽字符混淆。
- 模型限流、超时、流中断、降级链失败、预算超过 500 元、`UNKNOWN`/敏感数据外发阻断。
- 反馈重复、黄金题证据被合法删除、备份恢复后删除墓碑和权限事实仍需生效。
- Worker Profile 资源超限、OpenSearch fan-out 超限、候选数组/高风险缓冲无界、模型单次/每日/月度预算耗尽。

## 关键路径

1. 登录 -> 进入客服工作台 -> 上传 Markdown/PDF/JSON -> 安全检查 -> 解析 -> 分块/Embedding/关键词索引 -> Candidate Release -> 校验 -> Alias 激活 -> 提问 -> ACL 混合检索 -> Rerank Top5 -> 引用校验 -> 复制回复草稿。
2. 高风险问题 -> 证据闸门 -> 生成前缓冲 -> 句级验证失败 -> `REFUSED` 或 `EVIDENCE_ONLY`，确认事实正文没有提前发送。
3. 任务失败 -> 新 Attempt -> retry queue -> 再失败进入 DLQ -> 人工重放创建新 Generation -> 幂等完成并关闭原 Dead Letter。
4. 删除请求 -> 所有 deletion target -> OpenSearch/MinIO/Redis/RabbitMQ/Trace 清理证明 -> 旧 Snapshot 仅保留墓碑 -> 恢复演练后仍不能检索已删除正文。

## 评测与门禁

- TypeScript 使用 Vitest、Supertest、Testcontainers 和 Playwright；Python Parser 使用 pytest。CI 复用容器并按测试组启动 PostgreSQL、OpenSearch、RabbitMQ、Redis、MinIO、Keycloak，Parser 按需启动。
- P1 协议测试必须覆盖 Worker `ingestion/evaluation` 隔离、Keycloak Realm/过期/撤权、`upload_session -> promote -> object_claim -> cleanup`、删除优先级、Answer/Citation/Finalizer 边界，以及领域审计与异步遥测隔离。
- 领域单元测试覆盖每个状态轴合法/非法迁移、CAS 并发和 `searchable` 派生。
- 契约测试覆盖 Parser、Model、ObjectStorage、MessageBus 当前及上一 `schemaVersion`。
- 真实容器集成测试覆盖 PostgreSQL、OpenSearch、RabbitMQ、Redis、MinIO 的事务、Alias、重试、删除和恢复；并发 AnswerRun/SSE 还要覆盖 API 本地 semaphore 与 PostgreSQL 用户 lease 在 Redis 故障时仍生效。
- E2E 覆盖上传至引用草稿、权限撤销、SSE 续读、高风险缓冲、DLQ 重放和删除墓碑。
- RAG EVAL 固定语料、Manifest、模型、Prompt、索引快照和随机参数，覆盖 Recall@5、引用覆盖率与正确率、忠实度、拒答合理性、权威冲突和过期知识。
- Playwright 只覆盖关键浏览器链路，状态机、失败注入和跨组件一致性优先由 API/容器集成测试覆盖。
- 性能门禁固定 `worker:ingestion` 并发 4/in-flight 8、`worker:evaluation` 并发 1/in-flight 1、Parser 并发 1、OpenSearch fan-out 2/候选 1024/请求总超时 250 ms、高风险缓冲 2,048 output tokens；超限必须进入可观察降级而不是继续堆积。
- **Rerank 用例独立于上述 250 ms 门禁**（PROBE-005 Stage C 实测：8/64/256/1024 候选 → 0.89/0.95/1.45/3.4-6.6 s，¥0.0012/0.0099/0.0397/0.1587）：至少覆盖 (a) 送入候选数取自 `RetrievalManifest.rerankInputSize` 而不是环境变量，且超过该值时由 Adapter 侧自行截断——实测供应商对 2 倍冻结上限（2048 条）仍返回 200，不能依赖其拒绝；(b) 供应商 429 且不带 `retry-after` 时退避重试并在必要时截断候选降级，**限流不得被当作契约失败或排序结果**；(c) 断言 rerank 回显正文不出现在日志与快照中（`return_documents=false` 在该端点不生效）；(d) 排序质量用例必须把黄金文档放在候选末位，否则只回显输入顺序的假 Reranker 也能通过。
- 费用门禁按 PostgreSQL `model_budget_ledger` 预扣验证单次 <= 5 元、每日 <= 16 元、月度 <= 500 元，并验证交互 350 元、评测 100 元、应急 50 元预算池互不越界，以及 lease 过期回收与结算差额释放。预扣估值必须按 `rerankInputSize` 计算（rerank 是单次问答最大单项），结算优先写回供应商返回的 `usage.cost` 而非价目表估值；并单独覆盖「客户端超时/挂起但上游可能已计费」时预扣不被直接释放（见 2026-08-26 修订的 [ADR-0029](../adr/0029-model-budget-ledger-and-limits.md)）。
- 安全门禁使用独立于业务黄金集的注入样本集，覆盖直接注入、间接注入、编码与零宽字符混淆、表格/OCR 文本注入和跨文档串联注入；硬门禁是不越权泄漏、不触发工具或外链调用、不把未验证正文提交为最终快照，检出率与误报率只报告不阻断。
- 性能报告拆分 presign/complete、作用域预过滤+Snapshot、BM25/向量、ACL 候选复核、融合/Rerank、TTFT、生成和引用验证（常规 2.0 s / 高风险 3.5 s 分列，见 2026-08-26 修订的 [ADR-0027](../adr/0027-tiered-citation-verification-budget.md)）；`P50 1.2 s` 只能作为固定黄金集候选基线，不作为单一硬 SLO。
- 发布门禁：越权证据泄漏为 0；主链和回滚可运行；无据问题拒答或明确不确定；50 道黄金题固定版本可重复运行。
