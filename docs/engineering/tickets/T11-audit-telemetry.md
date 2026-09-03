# T11：Audit/Telemetry（同步领域审计与异步运行遥测）

## 目的

「可观测性」这个词盖住了两件性质相反的事。领域审计是业务事实的一部分：写不进去，业务就不该提交。运行遥测是诊断信息：丢了不许影响业务。本票据把这条原则从一句话变成两条互不依赖的代码路径——一条焊在业务事务里，一条挂在 Outbox 上，且在包依赖图上互相看不见。决策依据见 [ADR-0040](../../adr/0040-domain-audit-and-runtime-telemetry.md)（载体、数据形状与原因码口径）与 [ADR-0035](../../adr/0035-stage1-runtime-protocol-ratification.md) 第 13 行（同步/异步载体原则）。

现状是六处 ADR 在写它、零处定义它：`packages/database/prisma/schema.prisma` 的 10 个模型里没有审计表，`packages/observability/src` 共 4 个文件 265 行只有 health/logger/redaction，`packages/contracts/src` 只有 errors 与 manifests。[T12](T12-performance-budget.md) 的四类预算原因码和 [T14](T14-identity-authorization.md) 的授权决策审计都在等这个入口。

## 批次划分

按执行顺序拆两批，判据是「Outbox 到底存不存在」：

- **T11a 同步审计骨架** — `packages/contracts/src/audit/` 的事件形状与原因码注册表、`domain_audit_event` schema 与迁移、`packages/database` 的同事务写入口、[T12a](T12-performance-budget.md#批次划分) 四类预算原因码作为首个接入面。这一批是 HG-01 门禁四项之一：T12a 与 T14 的 DoD 都要求写同步领域审计，本批不落地，那两张票据只能各自拍一个形状，之后再迁移。
- **T11b 异步遥测与恢复** — `apps/api/src/modules/telemetry/`、遥测事件走 Outbox 投递与消费者、观测栈独立 Compose Profile、关闭消费者后业务与审计仍提交、Outbox 恢复后补投不重复。

T11a 不得推迟到 T12a 之后收口：账本的四类审计写入没有入口就落不了地，T12a 的 DoD 关不掉。T11b 不得提前到 T3 之前：`outbox_event` 表与 Relay 归 T3（HG-02 批次），此时提前只能造一套将来要删的临时投递，而 [ADR-0040](../../adr/0040-domain-audit-and-runtime-telemetry.md) 决策 7 明确不为遥测另立投递机制。

## 范围

- `packages/contracts/src/audit/`：审计事件形状、`category` 枚举与原因码注册表。不把 Prisma 生成类型暴露为领域契约。
- `packages/database/prisma/schema.prisma` 与新增迁移目录：`domain_audit_event` 及其枚举。按 T1a 口径单独计划、单独评审，不与接入代码混在一个提交里。
- `packages/database/`：全仓唯一的审计写入口。签名要求调用方传入已开启的事务句柄，不提供自建事务或 fire-and-forget 的重载。
- `apps/api/src/modules/audit/`：按域组装事件与原因码的编排层。阶段 1 不做通用审计检索 API（见 [ADR-0040](../../adr/0040-domain-audit-and-runtime-telemetry.md) 扩展点 3）。
- `apps/api/src/modules/telemetry/`：遥测事件投递、Trace 上下文传递、指标注册。
- `packages/observability/`：补指标与 Trace 入口，并把 `src/index.ts` 头注释里「审计事件」的归属改到 ADR-0040 的口径。**本包不新增审计写入口**。
- `infra/compose/`：观测栈独立 Profile。当前 `compose.yml` 只有 `parser` 与 `evaluation` 两个 profile，观测栈尚不存在。
- 首个接入面只做 T12a 的四类预算原因码；其余域随各自票据接入（T14 授权与成员变更、T13 注入命中、T2 状态命令、T8 删除与恢复）。

## 审计最小数据模型

`domain_audit_event` 一行 = 一次领域判定的事实，不是一条访问日志：

- 归属：`id`、`tenantId`、`occurredAt`。沿用仓库既有 Prisma 约定：`@id @default(uuid(7)) @db.Uuid`、`tenantId String @db.Uuid`、`DateTime @db.Timestamptz(6)`、`@@map("domain_audit_event")`、`@@unique([tenantId, id])`，使租户级外键用 `references: [tenantId, id]` 把租户谓词焊进外键。
- 分域：`category`（`BUDGET`/`AUTHZ`/`MEMBERSHIP`/`DATA_CLASS`/`INJECTION`/`EVIDENCE`/`DELETION`）与 `reasonCode`（取自契约注册表的命名空间字符串）。两个维度都要有，`category` 用于翻页与索引，`reasonCode` 用于精确断言。
- 主体与对象：`actorType`（`BUSINESS_USER`/`SYSTEM`）、`actorId`（可空，lease 回收一类系统动作没有业务用户）、`subjectType` + `subjectId`（被判定的资源）。
- 结果：`outcome`（`ALLOWED`/`DENIED`/`DEGRADED`/`RECLAIMED`）。域内语义不同但读侧口径统一，便于「查这个租户所有 `DENIED`」。
- 细节：`detail` JSONB，受脱敏口径约束。注入命中按 [ADR-0032](../../adr/0032-untrusted-content-and-prompt-injection.md) 记文档版本、Chunk id、命中模式名与处置结果，**但不记命中的原文**。
- 关联：`traceId` 可空。审计不依赖遥测——拿不到 traceId 也必须写成功，这是「二者不得互换载体」在字段层面的体现。
- 索引：`(tenantId, occurredAt)` 与 `(tenantId, category, occurredAt)`。读侧是按租户 + 时间 + 域翻页，缺这两个索引，T8 的删除证明查询会全表扫。

## 不变量

- 审计写入口只有一个，且必须传入已开启的事务。没有自建事务的重载，没有 fire-and-forget 版本：「拿不到事务就写不了审计」要在类型上成立，而不是靠评审提醒。
- 审计写失败即业务写失败，事务整体回滚。任何 `catch` 之后继续提交业务状态的路径都是缺陷。
- 遥测写失败必须被吞。遥测调用不得出现在业务事务内，业务路径不得 `await` 任何导出器。关掉观测栈、停掉消费者、拔掉 RabbitMQ，业务状态与审计都必须照常提交。
- `@rag/observability` 不得导出审计写入口；审计写入口不得 import 任何遥测导出器。这条要用依赖断言或 lint 规则钉住——它会在某次「顺手复用一下 logger」里悄悄消失。
- 原因码只能来自 `packages/contracts/src/audit/reason-codes.ts`。库里出现未注册的 `reasonCode` 是缺陷，不是灵活性。
- 审计行不可变，且不随业务数据删除而删除，含墓碑写入与 Legal Hold 释放。前提是 `detail` 不落正文，见下一条。
- `detail` 不得保存文档正文、Prompt、检索命中片段与凭证，复用 `packages/observability/src/redaction.ts` 的 `contentFieldNames`/`secretFieldNames` 两张字段名表。审计要能永久保留，就不能把不该永久保留的东西塞进去。
- 频次类软门不写领域审计（[ADR-0034](../../adr/0034-per-user-rate-limit-and-concurrency-quota.md) 第 11 行）：提问频次、每日次数、上传频次超限只计指标并返回 `429`。把每分钟的 `429` 写进审计，审计表会退化成访问日志。
- 审计表不承担用量统计。不得在审计行上做 `count` 当用量事实——用量的事实源是 `model_budget_ledger`（[T12](T12-performance-budget.md)）与指标。
- 审计读取必带 `tenantId` 谓词，与 [T14 DoD](T14-identity-authorization.md#dod) 的「按 id 查询必须带租户谓词」是同一条，不在审计侧另开一个按裸 id 查的口子。
- `traceId` 只接受严格校验过的 W3C `traceparent`，沿用 T1a 错误信封的口径，不回显任意客户端头。
- 同一件领域判定不得一半写审计、一半写遥测。判定事实全部进审计，遥测只带诊断维度；否则关掉遥测就等于丢掉一部分审计。

## 工作量估算

- P1，human: ~4d / CC: ~1d（[闭合记录 §16](../plan-eng-review-closure.md#16-实施任务) 冻结值，本票据不改这个数）。按批次分配：
  - T11a 同步审计骨架：human: ~2d / CC: ~0.5d。
  - T11b 异步遥测与恢复：human: ~2d / CC: ~0.5d。
- 拆分依据（T11a）：契约与原因码注册表约 0.5d；`domain_audit_event` schema、迁移与开发种子约 0.5d；同事务写入口与依赖方向断言约 0.5d；T12a 四类原因码接入与「审计写失败则业务回滚」的集成约 0.5d。
- 拆分依据（T11b）：telemetry 模块与 Trace 上下文传递约 0.5d；遥测事件走 Outbox 与消费者约 0.75d；观测栈 Compose Profile 约 0.25d；关闭消费者与恢复补投不重复的集成约 0.5d。
- 校准：与 [T12](T12-performance-budget.md) 同档（~4d）。难点不在建一张表，而在两条负向证明都要在集成层面成立——关掉遥测业务不受影响、审计写失败业务必须失败。这两条靠代码评审保不住。
- 重叠说明：Outbox 机制本身（表、Relay、Publisher Confirm、TTL/DLX、`dead_letter`）归 T3，本票据只新增遥测事件类型与消费者，不重复计入。[闭合记录 §16.1](../plan-eng-review-closure.md#16-实施任务) 的重叠明细里没有 T11 条目，本票据不改任何数字。

## 依赖与时点

- 依赖 [T0](T0-monorepo-foundation.md)（配置包、Compose、`packages/observability` 骨架）与 T1a（Prisma/迁移口径、租户模型、错误信封的 `traceId` 口径）。
- **T11a 是 HG-01 门禁四项之一**（T1a + T14 + T11 同步审计 + T12 Ledger/配置骨架，见[人工验收门禁](../manual-acceptance-gate.md#阶段-1-门禁点)）。当前批次执行顺序是 T12a → T11a → T14a → T14b。
- 与 T12a 的先后关系按 [T12 票据](T12-performance-budget.md) 第 27、79 行的口径：T12a 的账本 schema 与事务入口可以先落，但它的四类审计写入必须与 T11a 同批合并，不留到 T11 之后。两张表的迁移合到同一次迁移评审，避免同一批次评审两次 schema。
- 闭合记录第 16 节 T11 的时点写「同步领域审计随 T2/T3 的业务事务落地」。本票据按当前批次细化：**骨架（契约、表、写入口）在 T11a 内落地，接入面随各域票据推进**——T12a 预算四类在本批，T2 状态命令在 HG-02，T13 注入随 T4/T6/T7，T8 删除与恢复随管理收口批次。两处不矛盾：原时点约束的是审计写入随业务事务出现，不是骨架也要等到 T2。
- T11b 依赖 T3 的 `outbox_event` 与 RabbitMQ 消费者，落在 HG-02 之后；[门禁表](../manual-acceptance-gate.md#阶段-1-门禁点) HG-06 的「T11 收口」指的就是 T11b 的恢复演练。

## 验证

- 单元/契约：原因码注册表无重复码、无未注册码；审计事件形状 schema；`detail` 脱敏——传入 `documentText`/`prompt`/`authorization` 一类字段必须被替换为 `[REDACTED]`。
- 依赖方向：断言 `@rag/observability` 的导出面不含审计写入口，且审计写入口的依赖图不含遥测导出器（依赖断言测试或 lint 规则，二者取一）。
- PostgreSQL 集成：审计与业务写在同一事务内提交；**注入一次审计写失败，业务必须整体回滚**（这是 ADR-0035 第 13 行的核心，必须有测试而不是靠约定）；审计行在文档版本删除与墓碑写入后仍存在且不含正文；跨租户读取带谓词。
- 遥测降级集成：停掉指标/Trace 消费者与 RabbitMQ 后，业务状态与审计仍提交。T11a 用 stub 消费者验证，完整投递链路随 T11b。
- Outbox 恢复（T11b）：恢复后遥测按幂等键补投且不重复（闭合记录 T11 的原验证项）。
- 反向断言：频次类软门路径没有任何审计写入调用（ADR-0034 第 11 行的反向约束）。

## 回滚

- 回滚不得留下「业务写成功、审计写不了」的中间态。审计入口不可用时业务必须失败，不得临时改成 warn 后继续——那正是本票据要消除的失败模式。
- 迁移回滚保留已写入的审计行，与 T12「已 `SETTLED` 记录不回滚」是同一条：审计是已经发生的事实，回滚代码不回滚事实。只回滚尚未写入的结构。
- 遥测可以整段回滚（观测栈 Profile 不启动即可），但不得顺带关闭审计写入口，也不得把审计降级成异步以「保住吞吐」。

## DoD

- `domain_audit_event` schema 与迁移合并；原因码注册表落在 `packages/contracts/src/audit/` 且编译期可枚举。
- 审计写入口全仓唯一，签名要求事务句柄；有测试证明审计写失败导致业务事务回滚。
- 有依赖断言或 lint 规则钉住 `@rag/observability` 不导出审计入口、审计入口不依赖遥测导出器。
- 关闭 Trace/指标消费者后业务状态与审计仍提交（闭合记录 T11 原验证项）。
- T12a 的四类预算原因码在注册表登记并被真实写入路径使用；库内不存在未注册的 `reasonCode`。
- `detail` 脱敏有测试；审计行在删除、墓碑与 Legal Hold 释放后仍存在且不含正文。
- 频次类软门无审计写入路径，有一条反向断言钉住。
- T11b：Outbox 恢复后遥测补投不重复；观测栈以独立 Compose Profile 交付且默认不启动。
