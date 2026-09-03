---
status: accepted
date: 2026-09-03
decision-basis: T12 票据落地时发现领域审计有六处 ADR 级写入要求、零处定义
---

# 领域审计与运行遥测的载体、数据形状与原因码口径

## 决策

[ADR-0035](0035-stage1-runtime-protocol-ratification.md) 第 13 行已经把「审计同步、埋点异步」提升为 ADR 级事实，但它只定了载体原则，没定形状：审计写在哪个包、落哪张表、原因码由谁登记，都还没有权威答案。本 ADR 补齐这三件，七条不变量：

1. **两条载体按包边界分开，不靠约定。** 领域审计 = `packages/contracts/src/audit/`（事件形状与原因码）+ `packages/database/`（与业务事务同事务的写入口）+ `apps/api/src/modules/audit/`（编排）。运行遥测 = `packages/observability/`（结构化日志、指标、Trace）+ `apps/api/src/modules/telemetry/`。`@rag/observability` 不得导出审计写入口，审计写入口不得依赖任何遥测导出器。这样 ADR-0035 的「二者不得互换载体」是包依赖图上的事实，而不是每个实现者的自觉。
2. **一张 `domain_audit_event` 表，按 `category` + `reasonCode` 分域。** 不每域一张表：审计的读侧是「按租户、主体、时间跨域查」，六张表会让每次越权排查和删除证明都要 join；同事务写入也要求审计表与业务表同库。字段口径见 [T11 Ticket](../engineering/tickets/T11-audit-telemetry.md) 的最小数据模型，本 ADR 只定「一张表、两个分域维度」。
3. **原因码是集中注册表，域内加命名空间。** 唯一来源 `packages/contracts/src/audit/reason-codes.ts`，形如 `budget.reserve_rejected`、`authz.denied`、`dataclass.blocked`、`injection.suspected`。任何域不得绕过注册表往库里写自由字符串。理由与 `ERROR_STATUS`（`packages/contracts/src/errors.ts`）相同：只有一张编译期可枚举的表，才能测「每个原因码都有一条测试」和「同一件事不会有两个码」。
4. **审计写入口只接受已开启的事务句柄。** 不提供自建事务的重载，也不提供 fire-and-forget 版本。「拿不到事务就写不了审计」在类型上成立，ADR-0035 的「写失败则业务失败」才不必靠代码评审逐次保证。
5. **审计行不可变，且不随业务数据删除而删除。** 删除文档版本、写墓碑、Legal Hold 释放都不删审计行。前提是 `detail` 不保存文档正文、Prompt、检索命中片段与凭证（复用 `packages/observability/src/redaction.ts` 的 `contentFieldNames`/`secretFieldNames` 口径），因此删除正文不会留下「审计里还存着正文」的合规问题。T8 的删除证明本身要靠审计追溯，删除时连带清审计等于把证明和证据一起删掉。
6. **频次类软门不写领域审计。** 复述 [ADR-0034](0034-per-user-rate-limit-and-concurrency-quota.md) 第 11 行：提问频次、每日次数与上传频次超限只计指标并返回 `429`。写审计的是领域判定——预算四类（[ADR-0029](0029-model-budget-ledger-and-limits.md)）、授权决策与成员变更（[ADR-0039](0039-business-identity-and-unified-authorization.md)）、数据等级阻断与降级（[ADR-0025](0025-data-class-routing-enforcement-point.md)）、注入命中（[ADR-0032](0032-untrusted-content-and-prompt-injection.md)）、冲突消解与 Finalizer 结论（[ADR-0033](0033-deterministic-evidence-conflict-resolution.md)）、删除与恢复（T8）。把每分钟的 `429` 写进审计，审计表会退化成访问日志，真正需要人看的事件被淹掉。
7. **异步遥测复用已定的 Outbox，不另立投递机制。** 走 [ADR-0019](0019-event-driven-index-projections.md)/[ADR-0024](0024-rabbitmq-asynchronous-task-bus.md) 的 `outbox_event` + RabbitMQ + TTL/DLX + `dead_letter`，按幂等键对账重放，不宣称 exactly-once。Trace 与指标后端按 [ADR-0016](0016-local-minio-for-development.md) 走独立 Compose Profile 按需启动，默认不启动；观测栈关掉不影响任何业务提交，`traceId/spanId` 生成内建。

## 依据

要求写它的地方有六处 ADR 加两张票据，定义它的地方一处都没有：

- [ADR-0025](0025-data-class-routing-enforcement-point.md) 第 12 行（阻断与降级都写审计）、[ADR-0029](0029-model-budget-ledger-and-limits.md) 第 17 行（预扣失败、结算差额、lease 回收、池越界四类）、[ADR-0032](0032-untrusted-content-and-prompt-injection.md) 第 13 行（注入命中含文档版本、Chunk、命中模式与处置结果）、[ADR-0033](0033-deterministic-evidence-conflict-resolution.md) 第 15 行（Finalizer 选择、冲突来源与最终状态）、[ADR-0034](0034-per-user-rate-limit-and-concurrency-quota.md) 第 11 行（反向约束：频次软门不写）、[ADR-0036](0036-stage1-protocol-clarifications.md) 第 59 行（把「审计与异步遥测」钉在模型准入顺序末端）。
- [T12 Ticket](../engineering/tickets/T12-performance-budget.md) 第 27 行要求四类预算原因码接同步审计入口；[T14 Ticket](../engineering/tickets/T14-identity-authorization.md) 第 79 行要求授权决策写同步领域审计。

现状是三个空位：`packages/database/prisma/schema.prisma` 的 10 个模型里没有审计表；`packages/observability/src` 只有 health、logger、redaction 三个模块；`packages/contracts/src` 只有 errors 与 manifests。

归属也不唯一：`packages/observability/src/index.ts` 的头注释把「审计事件」按票据分给 T3/T10/T12/T14，而[闭合记录](../engineering/plan-eng-review-closure.md#16-实施任务)第 16 节把 `packages/observability/` 分给 T11。两处都不算错，但没有一处回答「审计写在哪个包、落哪张表、原因码谁登记」。这是需要 ADR 而不是票据补丁的信号：六个域都要写它，任何一个域先动手都会定义出只适合自己的形状，后来者要么迁移要么各写一套——而审计是出了事之后唯一的追溯面，各写一套等于没有。

## 已识别扩展点（阶段 1 不实现）

判据与 [ADR-0039](0039-business-identity-and-unified-authorization.md) 一致：阶段 1 没有任何验证项读它们。

1. **审计外发（SIEM 或日志平台）。** 阶段 1 审计只在 PostgreSQL 内可查。外发涉及数据出域与二次脱敏审查，进入时新增 ADR。
2. **防篡改哈希链或签名。** 阶段 1 靠数据库权限与不可变约束，不做链式哈希；引入时要一并定义校验时机和失败处置。
3. **租户自助审计检索界面。** T16b 只做删除证明、预算和恢复三类操作的结果证明视图，不做通用审计查询。

## 影响与后续

1. [T11 Ticket](../engineering/tickets/T11-audit-telemetry.md) 按本 ADR 建立，并拆为 T11a 同步审计骨架（HG-01 门禁内）与 T11b 异步遥测与恢复（依赖 T3 的 Outbox，落在 HG-02 之后）。
2. 闭合记录第 16 节 T11 的「计划文件」一行按本 ADR 细化：审计写入口不落 `packages/observability/`，该包只承载遥测与脱敏。闭合记录不重写，细化写在 T11 的范围补充里。
3. `packages/observability/src/index.ts` 的头注释按决策 1 更正：审计入口不在本包。
4. T12 与 T14 的「审计原因码」改为向 `packages/contracts/src/audit/` 的集中注册表登记，不各自定义字符串；两张票据的 DoD 数量不变。
5. 本 ADR 不改 ADR-0035 第 13 行的语义，也不改 ADR-0034 第 11 行的频次软门口径，只细化载体、数据形状与原因码归属。若未来要让领域审计走异步载体，必须新增 ADR 并显式 supersede 本文决策 4。
