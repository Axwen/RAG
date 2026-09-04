import { Prisma } from '../generated/prisma/client'
import type { Tx } from '../tx'
import type { BudgetWindow } from './windows'
import type { Cny, Pool } from './types'

/**
 * 预扣 CAS 需要的两条原始 SQL。放在一个文件里，是因为它们共享一条前提：
 * **check-then-insert 不是原子的**。窗口求和没有「那一行」可以加锁（要防的正是尚不存在的
 * 那一行），所以靠租户级 advisory lock 串行化，而不是 `SERIALIZABLE` + 重试循环。
 *
 * 事务时钟不在这里：`../tx-clock` 的 `txNow` 由账本与审计共用（见那个文件的说明）。
 */

/**
 * 按租户取排他 advisory lock，事务提交或回滚时自动释放。
 *
 * 粒度是**租户**而不是租户+池：日窗口与月窗口跨池求和，只锁池会让两个池的并发预扣各自
 * 看到过时的日用量，一起越过日限。这就是「两个请求同时预扣到日限边界只有一个成功」
 * （T12 验证一节）能成立的地方。
 *
 * `hashtext` 把 uuid 压成 int32，两个租户理论上可能撞到同一个锁槽：那时它们互相串行，
 * 是吞吐问题不是正确性问题（各自的 CAS 谓词都带自己的 `tenantId`）。
 *
 * `::text` 不是装饰：`pg_advisory_xact_lock` 返回 `void`，Prisma 的驱动反序列化不了这个类型，
 * 不加 cast 时整条语句直接抛 `Failed to deserialize column of type 'void'`（于是每一次预扣都在
 * 第一条语句上失败）。取回的值是空字符串，本来也没人看——要的只是那把锁。
 * 用 `$queryRaw` 而不是 `$executeRaw`，是为了让加锁与随后的幂等查询落在同一串调用里：
 * 「锁在读之前」这条顺序由 `packages/database/test/` 的调用序断言守着。
 */
export async function lockTenantBudget(tx: Tx, tenantId: string): Promise<void> {
  await tx.$queryRaw(
    Prisma.sql`SELECT pg_advisory_xact_lock(hashtext('model_budget_ledger'), hashtext(${tenantId}))::text AS "locked"`,
  )
}

export interface CommittedAmounts {
  /** 当日已占用（含 RESERVED 与 SETTLED，跨池）。 */
  daily: Cny
  /** 当月已占用（含 RESERVED 与 SETTLED，跨池）。 */
  monthly: Cny
  /** 当月本池已占用。 */
  poolMonthly: Cny
}

/**
 * 三个窗口的已占用金额，一次查询取回。
 *
 * 口径两条，改动前先想清楚：
 * - 只算 `RESERVED` 与 `SETTLED`。`RELEASED`/`EXPIRED` 已经把额度还回来了，再算一次等于
 *   钱没花却永久占额。
 * - `SETTLED` 按 `actualAmount`（实际发生的费用），`RESERVED` 按 `reservedAmount`（还没有
 *   实际值）。库里的 `model_budget_ledger_status_fields_consistent` CHECK 保证 `SETTLED` 行的
 *   `actualAmount` 非空，所以这个 CASE 不需要再 COALESCE。
 *
 * 和一律 `CAST(... AS TEXT)`：`numeric` 经驱动映射成 JS 值的方式不是这里能假定的，取字符串
 * 再交给 `new Prisma.Decimal(...)` 才是精确的。
 */
export async function committedAmounts(
  tx: Tx,
  scope: { tenantId: string; pool: Pool; day: BudgetWindow; month: BudgetWindow },
): Promise<CommittedAmounts> {
  const { tenantId, pool, day, month } = scope
  const rows = await tx.$queryRaw<Array<{ daily: string; monthly: string; poolMonthly: string }>>(
    Prisma.sql`
      SELECT
        CAST(COALESCE(SUM(CASE WHEN "createdAt" >= ${day.start} AND "createdAt" < ${day.end}
                               THEN "amount" ELSE 0 END), 0) AS TEXT) AS "daily",
        CAST(COALESCE(SUM("amount"), 0) AS TEXT) AS "monthly",
        CAST(COALESCE(SUM(CASE WHEN "pool" = ${pool}::"BudgetPool"
                               THEN "amount" ELSE 0 END), 0) AS TEXT) AS "poolMonthly"
      FROM (
        SELECT
          "createdAt",
          "pool",
          CASE WHEN "status" = 'SETTLED' THEN "actualAmount" ELSE "reservedAmount" END AS "amount"
        FROM "model_budget_ledger"
        WHERE "tenantId" = ${tenantId}::uuid
          AND "status" IN ('RESERVED', 'SETTLED')
          AND "createdAt" >= ${month.start}
          AND "createdAt" < ${month.end}
      ) AS "scoped"
    `,
  )
  const row = rows[0]
  if (row === undefined) {
    // 聚合查询必然返回一行；返回零行说明驱动或事务出了问题，此时 fail closed。
    throw new Error('读取预算用量失败：账本入口在读不到用量时不得放行')
  }
  return {
    daily: new Prisma.Decimal(row.daily),
    monthly: new Prisma.Decimal(row.monthly),
    poolMonthly: new Prisma.Decimal(row.poolMonthly),
  }
}
