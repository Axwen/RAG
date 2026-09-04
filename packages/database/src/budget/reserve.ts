import { resourceLimitsDefaults } from '@rag/config'
import { Prisma } from '../generated/prisma/client'
import type { Tx } from '../tx'
import { txNow } from '../tx-clock'
import { committedAmounts, lockTenantBudget } from './sql'
import type { BudgetLimits, Cny, Pool, ReserveRejection } from './types'
import { dayWindow, monthWindow } from './windows'

/**
 * 预扣（T12 [事务入口契约] 第 1 条）。
 *
 * 顺序不可调换：开事务 → 四层 CAS → 写 `RESERVED` 与 lease → 提交 → **然后**才发出模型调用。
 * 先调用后记账等于没有门禁。这个函数只做「提交」之前的部分，事务由调用方持有，所以它拿到的是
 * `tx` 而不是客户端。
 */

export interface ReserveBudgetInput {
  tenantId: string
  /** 幂等键让重放不重复扣款：命中已存在的行时返回那一行（`replayed: true`）。 */
  idempotencyKey: string
  pool: Pool
  estimatedAmount: Cny
  /** 与金额分开记录，不把「当时的汇率」折进金额里（T12 不变量）。 */
  exchangeRate: Cny
  /** 默认取配置，不硬编码 60。 */
  leaseSeconds?: number
  owner: { answerRunId: string } | { jobId: string }
  /**
   * 四层 CAS 的上限。
   *
   * 票据的签名里没有这一项，但四层 CAS 不可能没有上限来源，所以补成**可选**参数——与签名
   * 自己的 `leaseSeconds?: number // 默认取配置` 完全同一个处理方式，默认值同样来自
   * `@rag/config` 的 `resourceLimitsDefaults.budget`。这样 T15 的调用点不用改，测试能用很小的
   * 金额撞日限边界（不必造 ¥16 的假账），T12b/T14 的租户级覆盖值以后也只是多传一个已解析的
   * 上限对象，不需要再改一次形状。
   */
  limits?: BudgetLimits
}

export type ReserveBudgetResult =
  | {
      ok: true
      ledgerId: string
      reservedAmount: Cny
      leaseExpiresAt: Date
      replayed: boolean
    }
  | ({ ok: false } & ReserveRejection)

/**
 * 池的月度上限。三个池之和等于月度上限，由配置 schema 保证（ADR-0029）。
 *
 * 不从包根导出：票据的[事务入口契约]写「只从包根 index.ts 导出这五个函数与它们的类型」，
 * 上限查表是预扣的实现细节，调用方要读上限该读 `@rag/config`。
 */
function poolLimitCny(limits: BudgetLimits, pool: Pool): number {
  switch (pool) {
    case 'INTERACTIVE':
      return limits.pools.interactive
    case 'EVALUATION':
      return limits.pools.evaluation
    case 'RESERVE':
      return limits.pools.reserve
  }
}

/**
 * 归属列。库里的 `model_budget_ledger_owner_exactly_one` CHECK 要求恰好一个非空；
 * 在这里显式判一次，是为了让形状写错的调用方拿到一句能读懂的话，而不是一个
 * `check_violation` 原文。
 */
function ownerColumns(owner: ReserveBudgetInput['owner']): {
  answerRunId: string | null
  jobId: string | null
} {
  const answerRunId = 'answerRunId' in owner ? owner.answerRunId : null
  const jobId = 'jobId' in owner ? owner.jobId : null
  if ((answerRunId === null) === (jobId === null)) {
    throw new Error('预扣归属必须恰好是 answerRunId 或 jobId 之一：没有归属的账查不出是谁花的')
  }
  return { answerRunId, jobId }
}

/** 不足时 remaining 记 0 而不是负数：拒绝响应里出现负余额只会让读的人以为账错了。 */
function remainingOf(limit: number, used: Prisma.Decimal): Cny {
  const remaining = new Prisma.Decimal(limit).minus(used)
  return remaining.isNegative() ? new Prisma.Decimal(0) : remaining
}

export async function reserveBudget(
  tx: Tx,
  input: ReserveBudgetInput,
): Promise<ReserveBudgetResult> {
  const limits = input.limits ?? resourceLimitsDefaults.budget
  const leaseSeconds = input.leaseSeconds ?? limits.lease.defaultSeconds

  // 下面三条都是调用方的编程错误，不是业务结果，所以抛而不是返回 ok: false。
  // 返回 ok: false 会让「参数写错」和「预算真的不够」在调用方看起来一样。
  // 用比较而不是 Decimal 的 isNegative()/isPositive()：那两个方法只看符号位，
  // 对 0 会返回 isPositive() === true，汇率 0 就被放过去了。
  if (input.estimatedAmount.lessThan(0)) {
    throw new Error('预扣金额为负：估值函数出错时不得记账')
  }
  if (input.exchangeRate.lessThanOrEqualTo(0)) {
    throw new Error('汇率必须为正：汇率为 0 会把所有折算金额抹成 0，等于关掉门禁')
  }
  if (!Number.isInteger(leaseSeconds) || leaseSeconds <= 0) {
    throw new Error('lease 时长必须是正整数秒')
  }
  if (leaseSeconds > limits.lease.maxTotalSeconds) {
    throw new Error(
      `lease 时长 ${leaseSeconds}s 超过配置上限 ${limits.lease.maxTotalSeconds}s：长调用要显式续租，不得靠调大初始 lease`,
    )
  }

  // 归属校验放在锁之前：形状错的请求不该先占住租户的锁。
  const owner = ownerColumns(input.owner)

  // 串行化整段 check-then-insert。必须在幂等查询之前：否则两个同键请求可能都查不到行，
  // 然后一个插入成功、另一个撞唯一约束抛异常——重放本该安静返回同一行，而不是报错。
  await lockTenantBudget(tx, input.tenantId)

  const existing = await tx.modelBudgetLedger.findUnique({
    where: {
      tenantId_idempotencyKey: {
        tenantId: input.tenantId,
        idempotencyKey: input.idempotencyKey,
      },
    },
    select: { id: true, reservedAmount: true, leaseExpiresAt: true },
  })
  if (existing !== null) {
    // 命中就返回那一行，不看它现在是什么状态：重放的语义是「这次调用已经记过账」，
    // 已经结算完的调用重放同样不该再扣一次。
    return {
      ok: true,
      ledgerId: existing.id,
      reservedAmount: existing.reservedAmount,
      leaseExpiresAt: existing.leaseExpiresAt,
      replayed: true,
    }
  }

  const now = await txNow(tx)
  const day = dayWindow(now)
  const month = monthWindow(now)

  // 第一层：单次。不需要读库——一次调用要么在单次上限内，要么不在。
  if (input.estimatedAmount.greaterThan(limits.singleCallCny)) {
    return {
      ok: false,
      reason: 'budget.reserve_rejected',
      layer: 'SINGLE',
      remaining: new Prisma.Decimal(limits.singleCallCny),
    }
  }

  const used = await committedAmounts(tx, {
    tenantId: input.tenantId,
    pool: input.pool,
    day,
    month,
  })

  // 第二、三层：日与月。都是跨池求和——评测池花掉的钱同样算进当日总额。
  if (used.daily.plus(input.estimatedAmount).greaterThan(limits.dailyCny)) {
    return {
      ok: false,
      reason: 'budget.reserve_rejected',
      layer: 'DAILY',
      remaining: remainingOf(limits.dailyCny, used.daily),
    }
  }
  if (used.monthly.plus(input.estimatedAmount).greaterThan(limits.monthlyCny)) {
    return {
      ok: false,
      reason: 'budget.reserve_rejected',
      layer: 'MONTHLY',
      remaining: remainingOf(limits.monthlyCny, used.monthly),
    }
  }

  // 第四层：池边界。单独一个原因码，因为它的处理方式不同——池满是「评测负载不得吃掉交互池」
  // 这条隔离边界（T10 在费用维度上的同一条），不是租户没钱了。
  const poolLimit = poolLimitCny(limits, input.pool)
  if (used.poolMonthly.plus(input.estimatedAmount).greaterThan(poolLimit)) {
    return {
      ok: false,
      reason: 'budget.pool_boundary_rejected',
      pool: input.pool,
      remaining: remainingOf(poolLimit, used.poolMonthly),
    }
  }

  const created = await tx.modelBudgetLedger.create({
    data: {
      tenantId: input.tenantId,
      idempotencyKey: input.idempotencyKey,
      pool: input.pool,
      reservedAmount: input.estimatedAmount,
      exchangeRate: input.exchangeRate,
      // `createdAt` 必须显式传：Prisma Client 会在客户端为 `@default(now())` 生成值，列的
      // `DEFAULT CURRENT_TIMESTAMP` 只对省略该列的写入者生效。不传的话，四层 CAS 按事务时钟
      // 校验窗口、行却落在客户端时钟上——跨零点的那一次调用就能绕过日限（`committedAmounts`
      // 求和的正是这一列）。
      createdAt: now,
      // 同一个时刻推 lease，回收窗口与 CAS 窗口因此对齐。
      leaseExpiresAt: new Date(now.getTime() + leaseSeconds * 1000),
      ...owner,
    },
    select: { id: true, reservedAmount: true, leaseExpiresAt: true },
  })
  return {
    ok: true,
    ledgerId: created.id,
    reservedAmount: created.reservedAmount,
    leaseExpiresAt: created.leaseExpiresAt,
    replayed: false,
  }
}
