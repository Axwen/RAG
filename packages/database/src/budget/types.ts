import type { ReasonCode } from '@rag/contracts'
import type { ResourceLimits } from '@rag/config'
import type { Prisma } from '../generated/prisma/client'

/**
 * 预算账本事务入口的共享类型（T12 [事务入口契约]）。
 *
 * 形状由票据钉死，不由实现者自创：T15 的每次模型调用与 T11a 的审计写入都建在上面。
 */

/**
 * 金额一律 `Prisma.Decimal`（列用 `@db.Decimal(12, 6)`）。
 *
 * 不用 `number`：¥0.0012 这种四位小数在一个月的账本行上累加，浮点误差会变成对不上的账。
 * 估值函数（`@rag/config` 的 `estimateAnswerRunCny`）返回 `number`，调用侧在进账本前
 * 用 `new Prisma.Decimal(...)` 包一层——这是两个包边界上唯一一次转换。
 */
export type Cny = Prisma.Decimal

/** 与 Prisma 枚举 `BudgetPool` 同一组值（`@rag/config` 侧是小写，各自语言的既有约定）。 */
export type Pool = 'INTERACTIVE' | 'EVALUATION' | 'RESERVE'

/**
 * 预算上限。`@rag/config` 的 `budgetLimitsSchema` 校验后的形状，这里只取一个别名，
 * 不重新声明字段：重新声明就会有两份「什么算预算上限」，配置改了这边不会报错。
 */
export type BudgetLimits = ResourceLimits['budget']

/**
 * 拒绝原因直接从注册表取（`packages/contracts/src/audit/reason-codes.ts`），
 * 不在这里另起字符串。码从注册表删掉时 `Extract` 变成 `never`，所有构造点编译失败——
 * 比「记得同步改两处」可靠。
 */
type ReserveRejectedCode = Extract<ReasonCode, 'budget.reserve_rejected'>
type PoolBoundaryRejectedCode = Extract<ReasonCode, 'budget.pool_boundary_rejected'>

/**
 * 预扣被拒的两种形状。超限是业务结果不是异常（ADR-0029：降级 / `EVIDENCE_ONLY` /
 * `REFUSED`），所以走返回值让调用方分支处理。
 *
 * `remaining` 的口径按层不同：`DAILY`/`MONTHLY` 与池边界是「还剩多少」（不足时可能是 0），
 * `SINGLE` 是单次上限本身——单次层没有「已用」的概念，一次调用要么在上限内要么不在。
 */
export type ReserveRejection =
  | { reason: ReserveRejectedCode; layer: 'SINGLE' | 'DAILY' | 'MONTHLY'; remaining: Cny }
  | { reason: PoolBoundaryRejectedCode; pool: Pool; remaining: Cny }
