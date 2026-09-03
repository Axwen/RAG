# T12：Performance/Budget（配置硬上限、Budget Ledger、限流与性能门禁）

## 目的

把「本地可用性」的四条硬边界从文档变成会拒绝请求的代码：无界候选与 N+1 查询、缓存过期授权、用户级并发/频次失控、模型费用失控。其中费用部分是唯一一条**钱已经花掉就收不回来**的边界，所以它不是限流器而是一本账：任何模型调用前先在 PostgreSQL 里预扣，调用后按供应商实际用量结算，崩溃由 lease 回收。决策依据见 [ADR-0029](../../adr/0029-model-budget-ledger-and-limits.md)（预算账本与硬上限）与 [ADR-0034](../../adr/0034-per-user-rate-limit-and-concurrency-quota.md)（用户级限流与并发配额）。

[T0](T0-monorepo-foundation.md) 已把 5/16/500 元落成可校验配置（`packages/config/src/resource-limits.ts` 的 `budgetLimitsSchema`），但只做到「配置写错会启动失败」；运行时没有任何东西读它。本票据补上账本、事务入口和门禁。

## 批次划分

按执行顺序拆两批，判据是「T15 ModelAdapter 到底卡在哪一部分上」：

- **T12a 预算账本与配置骨架** — `model_budget_ledger` schema 与迁移、预扣/结算/释放/lease 回收的事务入口、配置硬上限补全（池三分与 ADR-0034 配额值）。这一批是 [T15](T15-model-adapter.md) 的前置（T15 依赖项写的是「T12 的 Budget Ledger schema/事务入口」），也是 HG-01 门禁四项之一。
- **T12b 限流、缓存与性能报告** — 用户级并发/频次的运行时强制、Redis 作用域缓存按 `aclRevision` 失效、批量查询计数门禁、分项延迟与完整性能报告。检索侧随 T6 验证，完整报告在 T9 后收口。

T12a 不得为了等 T12b 而推迟：没有账本，T15 之后的每一次模型调用都是无门禁调用。T12b 不得提前到 T6 之前收口：那时既没有真实检索链路也没有评测语料，量出来的分项延迟没有意义。

## 范围

- `packages/database/prisma/schema.prisma` 与新增迁移目录：`model_budget_ledger` 及其枚举。按 T1a 口径单独计划、单独评审，不与门禁代码混在一个提交里。
- `packages/database/`：预扣、结算、释放、lease 回收四条事务入口。调用方只看到入口，不允许业务模块自己拼 SQL 改账。
- `packages/config/`：`budgetLimitsSchema` 补池三分（交互 350 / 评测 100 / 应急 50）与汇率配置项；新增 ADR-0034 的四项用户级配额与管理侧 `rebuild` 并发；补 lease 时长与续租上限。
- `apps/api/src/modules/model/`：预扣与结算的调用侧编排入口（**供应商方言、`usage.cost` 读取、429 退避、流式取消触发结算归 [T15](T15-model-adapter.md)**，本票据只提供它调用的账本入口与原因码）。
- `apps/api/src/modules/retrieval/`：Redis 作用域缓存及其按 `aclRevision` 的失效；批量查询替换逐条查询。
- 用户级限流载体：Redis 计数软门（频次、每日、上传）+ API 本地信号量 + PostgreSQL 可恢复并发 lease（`AnswerRun`/SSE）。
- `tests/performance/`：批量查询计数断言与分项延迟报告。
- 领域审计原因码：预扣失败、结算差额、lease 回收、池边界拒绝四类。写入路径接 T11 Audit/Telemetry 的同步审计入口，与 T11 同批交付，不留到 T11 之后。

## Ledger 最小数据模型

`model_budget_ledger` 一行 = 一次「打算花钱」的完整生命周期，不是一条流水日志：

- 归属：`tenantId`、`answerRunId` 或 `jobId`、幂等键。幂等键让重放不重复扣款。
- 分池：`pool ∈ {interactive, evaluation, reserve}`、`period ∈ {日, 月}`。评测负载不得吃掉交互池，这是 T10 资源隔离在费用维度上的同一条边界。
- 金额：`reservedAmount`（预扣估值）、`actualAmount`（结算实际）。两者都记，差额本身是审计对象。
- 生命周期：`status ∈ {RESERVED, SETTLED, RELEASED, EXPIRED}`、`leaseExpiresAt`。
- 沿用仓库既有 Prisma 约定：`@id @default(uuid(7)) @db.Uuid`、`DateTime @db.Timestamptz(6)`、`@@map("model_budget_ledger")`、`@@unique([tenantId, id])` 以便租户级外键用 `references: [tenantId, id]` 把租户谓词焊进外键；枚举写在文件顶部并注明 ADR 出处。

状态机（合法转移只有这四条，其余一律拒绝）：

- `RESERVED → SETTLED`：拿到实际用量，按实际金额结算并释放差额。
- `RESERVED → RELEASED`：调用未发生（数据等级门禁拦下、客户端在发出前取消）。
- `RESERVED → EXPIRED`：lease 过期回收任务发现无人结算。
- 流式调用在流结束或取消时结算；取消按已产出 token 结算，不按预扣值。

预扣事务的顺序不可调换：开事务 → CAS 校验单次/日/月/池四层 → 写 `RESERVED` 与 lease → 提交 → **然后**才发出模型调用。先调用后记账等于没有门禁。

## 不变量

- 余额的事实源只有 PostgreSQL 的 `model_budget_ledger`。Redis 可以缓存剩余额度用于展示和快速拒绝，**不得作为放行依据**：Redis 说还有钱不算有钱。
- 没有 `RESERVED` 记录的模型调用是缺陷，不是优化。
- 结算口径以供应商返回的 `cost` 为准（OpenRouter 在 `usage` 里返回）；本地价格表只用于预扣估值与供应商未返回时的兜底。汇率是独立配置项，与结算金额分开记录，不把「当时的汇率」丢进金额里。
- Rerank 预扣估值必须由候选数计算，不得用固定值：候选 8 → ¥0.0012、64 → ¥0.0099、256 → ¥0.0397、1024 → ¥0.1587（汇率 7.2）。`rerankInputSize` 因此是预算参数，取自 `RetrievalManifest`，不从前端或环境变量覆盖。
- 单次 ≤ 5 元要覆盖一次问答的全部四类调用之和（Chat + 查询 Embedding + Reranker + 逐句验证 Embedding/蕴含），不是只算 Chat。
- 超限只允许排队、暂停、降级、`EVIDENCE_ONLY` 或 `REFUSED`。不得静默继续，也不得悄悄改小候选数或跳过验证来「省钱」——那是把成本门禁偷换成质量降级。
- 「已计费但没结果」必须分成两类处理：上游明确拒绝（429、无 `usage`、无 `retry-after`）按零成本重试并只结算成功那次；客户端超时或挂起**不得释放预扣**，留给对账或 lease 过期，因为钱可能真的花了。
- lease 默认 60s；长调用必须显式续租，不得靠调大默认值掩盖没人续租的事实。
- 并发类限额不得只依赖 Redis。Redis 不可用时频次类可以告警放行，但 `AnswerRun`/SSE 并发必须有 API 本地信号量 + `AnswerRun` 创建事务里的 PostgreSQL 可恢复并发 lease。不接受静默降级。
- 超限响应不得泄漏他人用量：不回显租户总用量、不回显其他用户的剩余额度。
- 每一项限额可按租户覆盖，但覆盖值仍受硬上限约束——配出大于 5/16/500 的值必须启动失败，硬上限是代码里的上界而不是纯配置。
- 预算上限只在启动时解析并 fail-fast，运行时不从环境变量热改。
- 作用域缓存按 `aclRevision` 失效；撤权、墓碑、Legal Hold 优先于缓存（与 [T14](T14-identity-authorization.md) 的同名不变量是同一条，不得在检索侧另立一套缓存口径）。
- 错误信封的 `ERROR_STATUS` 是双射（`packages/contracts/src/errors.ts`）：一个错误码占一个状态码。用户级配额落既有的 `RATE_LIMITED`/429 并带 `Retry-After`（见 [错误码文档](../error-codes.md)）；预算耗尽按 ADR-0029 是降级/`EVIDENCE_ONLY`/`REFUSED` 的业务结果，需要 HTTP 拒绝时同样落 `RATE_LIMITED`，靠 `doc_url` 区分。**不得为预算新增一个也映射到 429 的错误码**，那会打破双射并让反向查找失效。

## 工作量估算

- P1，human: ~4d / CC: ~1d（[闭合记录 §16](../plan-eng-review-closure.md#16-实施任务) 冻结值，本票据不改这个数）。按批次分配：
  - T12a 预算账本与配置骨架：human: ~2d / CC: ~0.5d。
  - T12b 限流、缓存与性能报告：human: ~2d / CC: ~0.5d。
- 拆分依据（T12a）：`model_budget_ledger` schema、迁移与开发种子约 0.5d；预扣事务（四层 CAS + `RESERVED` + lease）约 0.5d；结算/释放/lease 过期回收三条路径与两类「已计费无结果」约 0.5d；配置补池三分、汇率、ADR-0034 四项配额及硬上限一致性校验约 0.5d。
- 拆分依据（T12b）：用户级限流运行时（Redis 计数软门 + 本地信号量 + PostgreSQL 并发 lease + `Retry-After`）约 1d；Redis 作用域缓存与 `aclRevision` 失效约 0.25d；批量查询计数门禁约 0.25d；分项延迟报告与 `tests/performance/` 约 0.5d。
- 校准：与 T11 同档（~4d）。难点不在写限流器，而在两处状态机的分支完备性——预算结算的四条转移，以及 Redis 不可用时并发限额的降级路径。协议与费率风险已由 PROBE-005 实测消除（见 [PROBE-005 决策日志](PROBE-005-model-adapter-decision-log.md)）。
- 重叠说明：[闭合记录 §16.1](../plan-eng-review-closure.md#16-实施任务) 的重叠明细已在小计层面扣除「T12 → T15 模型预算门禁 -0.5d」与「T8/T9/T12 → T16b 删除证明与报告页面 -0.5d」。落到本票据的含义是**范围边界而不是再减一次数字**：账本的调用侧（供应商方言、`usage.cost` 读取、429 退避、流式取消触发结算）归 T15，预算熔断的展示面归 T16b；本票据只负责 schema、事务入口、配置与服务端门禁。两批之和仍按冻结值记，避免两处文档各减一次。

## 依赖与时点

- 依赖 [T0](T0-monorepo-foundation.md)（配置包、Compose、Redis）与 T1a（Prisma/迁移口径、租户模型）。
- **T12a 必须在 [T15](T15-model-adapter.md) 前完成**，且是 HG-01 门禁四项之一（T1a + T14 + T11 同步审计 + T12 Ledger/配置骨架）。
- 领域审计写入与 T11 Audit/Telemetry 的同步审计入口同批交付；本票据只定义原因码与调用点。
- T12b 的检索侧验证随 T6，完整性能报告在 T9 链路具备后收口；`AnswerRun`/SSE 并发限额随 T7 的 SSE 端点落地后才能端到端验证。
- 用户级配额的身份上下文来自 [T14](T14-identity-authorization.md)：限额主体是 `businessUser`，不是请求体里的 `tenantId`。

## 验证

- 单元/契约：配置 schema 边界（5/16/500 上界、池求和 350+100+50 与 16×31=496 的自洽、覆盖值超硬上限即失败）；rerank 预扣估值随候选数变化；结算差额计算；状态机非法转移被拒。
- PostgreSQL 集成：两个请求同时预扣到日限边界只有一个成功；幂等键重放不重复扣款；lease 过期回收把 `RESERVED` 变 `EXPIRED` 并释放额度；租户 A 的预扣不影响租户 B 的可用额度。
- Redis 集成：每分钟窗口与每日计数；`429` 带 `Retry-After`；停掉 Redis 后频次类告警放行、`AnswerRun`/SSE 并发仍然生效（ADR-0034 明确要求这条分叉不得静默降级）。
- 并发 SSE 集成：同一用户第 3 条 SSE 被拒，且拒绝响应不含其他用户的用量信息。
- 性能：`tests/performance/` 断言批量查询计数（N+1 回归）与分项延迟报告；随 T6/T9 收口，不阻塞 T12a。
- 供应商结算口径：用 PROBE-005 记录的真实 `usage` 报文做契约测试；LIVE 供应商调用不进普通 CI（CI 不得触发付费模型调用）。

## 回滚

- 回滚不得放宽预算。读不到账本时 fail closed（拒绝调用），不得默认放行——「读不到就先花」是这条门禁最贵的失败模式。
- 迁移回滚必须保留已 `SETTLED` 的记录：那是已经发生的费用事实，回滚代码不能回滚钱。只回滚尚未被写入的结构。
- 配置回滚不得把硬上限调高；硬上限的上界在代码里，配置只能往下调。
- 限流回滚可以放宽频次类软门，但不得移除 `AnswerRun`/SSE 并发的 PostgreSQL lease：那是防止单用户吃满 Worker 的最后一道。

## DoD

- `model_budget_ledger` schema 与迁移合并，且 T15 只依赖事务入口即可工作，不需要直接读写表结构。
- 预扣、结算、释放、lease 过期回收四条路径各有测试；并发预扣有竞态测试。
- 预扣失败、结算差额、lease 回收、池边界拒绝四类都写领域审计（ADR-0029 要求），且 Trace/遥测故障不影响拒绝结果。
- 配置 schema 覆盖 5/16/500、池 350/100/50、汇率、lease 时长和 ADR-0034 的四项用户级配额（并发 `AnswerRun` 1、并发 SSE 2、提问 10 次/分与 200 次/日、上传 20 文件/小时）与管理侧 `rebuild` 每租户并发 1，并有「配出超硬上限即启动失败」的测试。
- 429 响应带 `Retry-After`，且有测试钉住响应不泄漏他人用量。
- 停掉 Redis 的集成测试证明并发限额仍然生效，且没有任何路径靠 Redis 单点放行预算。
- 「已计费无结果」两类各有测试：上游 429 零成本重试只结算成功那次；客户端超时不释放预扣。
- ADR-0034 的五个限额值（四项用户级 + 管理侧 `rebuild`）以运行时配置形式落地，标注为初始值可校准，调整不需要新 ADR。
- T12b 的分项延迟报告在 T9 后产出并归档；T12a 的合并不以该报告为前置。
