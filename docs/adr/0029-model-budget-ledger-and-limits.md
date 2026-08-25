---
status: accepted
---

# 模型预算使用 PostgreSQL Ledger 预扣、结算与 Lease 回收

原设计只写了"调用前预扣"四个字，没有指定原子性载体、并发串行化点、实际用量对账方式和崩溃后的释放路径；同时三个上限互不相容——每日 20 元乘 30 天为 600 元，超过月度 500 元。本 ADR 同时修这两处。

预算账本是 PostgreSQL 表 `model_budget_ledger`，字段至少包含 `tenantId`、`pool`（`interactive` / `evaluation` / `reserve`）、`period`（日 / 月）、`reservedAmount`、`actualAmount`、`leaseExpiresAt`、`status`（`RESERVED` / `SETTLED` / `RELEASED` / `EXPIRED`）以及调用侧的 `answerRunId` 或 `jobId` 与幂等键。`ModelAdapter` 在调用前开启事务，用 CAS 校验单次、每日、月度和池上限，写入一条 `RESERVED` 记录并取得带 lease 的预扣号，提交后才发起模型调用。

调用结束后写入实际用量并将记录置为 `SETTLED`，同时释放预扣与实际用量之间的差额。流式调用在流结束或被取消时结算，取消按已产生 token 结算而不是全额释放。进程崩溃或响应丢失时由 lease 过期驱动回收任务把记录置为 `EXPIRED` 并释放额度；lease 默认 60 秒，超过单次预算上限的长调用必须显式续租。Redis 只允许缓存当前剩余额度用于前端展示和快速拒绝，不作为预算事实源。

三个上限口径修正为：单次 ≤ 5 元，每日 ≤ 16 元，月度 ≤ 500 元，池划分为交互 350 元、评测 100 元、应急保留 50 元。每日 16 元乘 31 天为 496 元，三个上限自此自洽。ADR-0017 的首月 500 元上限不变。批量评测集中运行时只能通过评测池排队和分批完成，不允许临时提高日上限。

超限行为仍然只有排队、暂停、降级、`EVIDENCE_ONLY` 和 `REFUSED`，不允许运行时自动突破上限。预扣失败、结算差额、lease 回收和池越界拒绝都写领域审计，使"预算耗尽"与"静默失败"在事后可区分。
