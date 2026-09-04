import { resourceLimitsDefaults } from '@rag/config'
import { Prisma } from '../generated/prisma/client'
import type { Tx } from '../tx'
import { txNow } from '../tx-clock'
import type { BudgetLimits, Cny, Pool } from './types'

/**
 * lease 过期回收与续租（T12 [事务入口契约] 第 4、5 条）。
 *
 * 这两条撑着同一条不变量：**客户端超时或挂起不得释放预扣**。钱可能真的花了，所以那种情况既不能
 * `releaseBudget` 也不能放着不管——只能等 lease 过期被回收成 `EXPIRED`，或由对账修正。
 */

export interface ExpiredLease {
  ledgerId: string
  tenantId: string
  reservedAmount: Cny
  pool: Pool
}

/**
 * 批量把过期未结算的 `RESERVED` 变 `EXPIRED` 并释放额度，返回被回收的行以便**逐条**写审计
 * （`budget.lease_expired`，`outcome: RECLAIMED`）。
 *
 * 一条 SQL 完成挑行、更新与排序：
 * - `FOR UPDATE SKIP LOCKED`：多个回收任务实例可以并跑，各拿一批互不阻塞；跳过的行下一轮再回收。
 * - `candidate` CTE 里的 `WHERE status = 'RESERVED' AND leaseExpiresAt <= now` 走索引
 *   `(status, leaseExpiresAt)`（这就是那个索引必须以 `status` 开头的原因：回收任务不带 `tenantId`）。
 *   `ORDER BY ... LIMIT` 决定**挑哪些行**：卡最久的先还额度，一批新过期的行不会把老行挤到永远轮不到。
 * - **外层 `SELECT ... ORDER BY "leaseExpiresAt"` 不是多余的。** `RETURNING` 的行序是执行计划的
 *   副产物，PostgreSQL 不保证它等于子查询的 `ORDER BY`——实测同一批两行会随计划反序返回。
 *   返回值要逐条写审计，行序不定会让「回收顺序」成为计划的函数，也让批次断言偶发红。
 *   于是把 UPDATE 收进 CTE，在外层重新排一次：多排最多 `limit` 行，换来确定的批次。
 * - `finalizedAt` 取 `CURRENT_TIMESTAMP` 而不是入参 `now`：入参是「回收判据」，可以由调用方按
 *   自己的时钟给；写进行里的终态时间必须是数据库时间，与其他三条终态路径一致。
 */
export async function expireBudgetLeases(
  tx: Tx,
  input: { now: Date; limit: number },
): Promise<ExpiredLease[]> {
  if (!Number.isInteger(input.limit) || input.limit <= 0) {
    throw new Error('回收批量上限必须是正整数：无界回收会把一次任务变成全表更新')
  }
  const rows = await tx.$queryRaw<
    Array<{ ledgerId: string; tenantId: string; reservedAmount: string; pool: Pool }>
  >(Prisma.sql`
    WITH "candidate" AS (
      SELECT "id"
      FROM "model_budget_ledger"
      WHERE "status" = 'RESERVED'
        AND "leaseExpiresAt" <= ${input.now}
      ORDER BY "leaseExpiresAt"
      LIMIT ${input.limit}
      FOR UPDATE SKIP LOCKED
    ), "reclaimed" AS (
      UPDATE "model_budget_ledger" AS "target"
      SET "status" = 'EXPIRED', "finalizedAt" = CURRENT_TIMESTAMP
      WHERE "target"."id" IN (SELECT "id" FROM "candidate")
      RETURNING
        "target"."id",
        "target"."tenantId",
        "target"."reservedAmount",
        "target"."pool",
        "target"."leaseExpiresAt"
    )
    SELECT
      "id" AS "ledgerId",
      "tenantId" AS "tenantId",
      CAST("reservedAmount" AS TEXT) AS "reservedAmount",
      "pool" AS "pool"
    FROM "reclaimed"
    ORDER BY "leaseExpiresAt"
  `)
  return rows.map((row) => ({
    ledgerId: row.ledgerId,
    tenantId: row.tenantId,
    reservedAmount: new Prisma.Decimal(row.reservedAmount),
    pool: row.pool,
  }))
}

export interface RenewBudgetLeaseInput {
  ledgerId: string
  tenantId: string
  leaseSeconds: number
  /** 与 `reserveBudget` 同一处理：可选，默认取配置。续租上限的唯一来源是 `@rag/config`。 */
  limits?: BudgetLimits
}

/**
 * 续租。只推 `leaseExpiresAt`，不改 `status`，所以不算「四条」里的一条。
 *
 * 两道上限都来自配置，超任一道即 `RENEW_LIMIT_EXCEEDED`：
 * - `maxRenewSeconds`：单次续租时长。
 * - `maxTotalSeconds`：从 `createdAt` 起算的总时长。用总时长而不是续租次数，是因为次数不能阻止
 *   「每次续 300 秒续二十次」。`renewCount` 仍然递增，但它是对账用的观测值，不是判据。
 *
 * 「不得靠调大 lease 默认值掩盖没人续租」这条不变量的落点在这里和 `reserveBudget` 的入参校验，
 * 不在配置文件里。
 */
export async function renewBudgetLease(
  tx: Tx,
  input: RenewBudgetLeaseInput,
): Promise<
  | { ok: true; leaseExpiresAt: Date }
  | { ok: false; reason: 'RENEW_LIMIT_EXCEEDED' | 'ILLEGAL_TRANSITION' }
> {
  const limits = input.limits ?? resourceLimitsDefaults.budget
  if (!Number.isInteger(input.leaseSeconds) || input.leaseSeconds <= 0) {
    throw new Error('续租时长必须是正整数秒')
  }
  if (input.leaseSeconds > limits.lease.maxRenewSeconds) {
    return { ok: false, reason: 'RENEW_LIMIT_EXCEEDED' }
  }

  const row = await tx.modelBudgetLedger.findFirst({
    where: { id: input.ledgerId, tenantId: input.tenantId },
    select: { status: true, createdAt: true },
  })
  if (row === null) {
    throw new Error('账本行不存在：读不到账本时不得返回放行语义')
  }
  if (row.status !== 'RESERVED') {
    return { ok: false, reason: 'ILLEGAL_TRANSITION' }
  }

  const now = await txNow(tx)
  const leaseExpiresAt = new Date(now.getTime() + input.leaseSeconds * 1000)
  const totalDeadline = new Date(row.createdAt.getTime() + limits.lease.maxTotalSeconds * 1000)
  if (leaseExpiresAt.getTime() > totalDeadline.getTime()) {
    return { ok: false, reason: 'RENEW_LIMIT_EXCEEDED' }
  }

  // 状态谓词照旧写在 where 里：并发的结算/回收把行改成终态后，这次续租必须落空而不是复活它。
  const changed = await tx.modelBudgetLedger.updateMany({
    where: { id: input.ledgerId, tenantId: input.tenantId, status: 'RESERVED' },
    data: { leaseExpiresAt, renewCount: { increment: 1 } },
  })
  if (changed.count === 0) {
    return { ok: false, reason: 'ILLEGAL_TRANSITION' }
  }
  return { ok: true, leaseExpiresAt }
}
