import { Prisma } from '../generated/prisma/client'
import type { Tx } from '../tx'
import { txNow } from '../tx-clock'
import type { Cny } from './types'

/**
 * 结算与释放（T12 [事务入口契约] 第 2、3 条）：`RESERVED → SETTLED` 与 `RESERVED → RELEASED`。
 *
 * 两条都用 `updateMany({ where: { status: 'RESERVED' } })` 而不是先读后写：`where` 里的状态谓词
 * 让「判断」和「写入」落在同一条语句里，两个并发结算只有一个能改到行。库里的
 * `model_budget_ledger_transition_guard` 触发器会对终态行的 UPDATE 直接抛异常，所以这里必须靠
 * 谓词避开它——否则重复结算拿到的是一个 `check_violation` 原文而不是 `ILLEGAL_TRANSITION`。
 */

/** 非法转移是业务结果（调用方要能分支处理），读不到账本才是异常。 */
export interface IllegalTransition {
  ok: false
  reason: 'ILLEGAL_TRANSITION'
  status: string
}

/** 状态谓词没改到行时，回头读一次真实状态。读不到行就抛——fail closed，不返回放行语义。 */
async function illegalTransition(
  tx: Tx,
  where: { ledgerId: string; tenantId: string },
): Promise<IllegalTransition> {
  const row = await tx.modelBudgetLedger.findFirst({
    // 按 id 查必须带租户谓词（与 T14 DoD 同一条），不留按裸 id 查的口子。
    where: { id: where.ledgerId, tenantId: where.tenantId },
    select: { status: true },
  })
  if (row === null) {
    throw new Error('账本行不存在：读不到账本时不得返回放行语义')
  }
  return { ok: false, reason: 'ILLEGAL_TRANSITION', status: row.status }
}

export interface SettleBudgetInput {
  ledgerId: string
  tenantId: string
  /** 以供应商返回的 `cost` 为准；供应商没返回时传本地估值并置 `costSource: 'ESTIMATED'`。 */
  actualAmount: Cny
  costSource: 'PROVIDER' | 'ESTIMATED'
}

/**
 * 结算。返回 `delta = actualAmount - reservedAmount`：差额本身是审计对象
 * （`budget.settlement_delta`，`delta ≠ 0` 或 `costSource: 'ESTIMATED'` 时由调用方在同一个 `tx`
 * 上写审计）。差额为负说明预扣估高了，多占的额度随本次结算自动还回——用量求和对 `SETTLED` 行
 * 取的是 `actualAmount`，不需要再写一条冲账行。
 */
export async function settleBudget(
  tx: Tx,
  input: SettleBudgetInput,
): Promise<{ ok: true; delta: Cny } | IllegalTransition> {
  if (input.actualAmount.lessThan(0)) {
    throw new Error('结算金额为负：供应商用量解析出错时不得记账')
  }

  const reserved = await tx.modelBudgetLedger.findFirst({
    where: { id: input.ledgerId, tenantId: input.tenantId },
    select: { reservedAmount: true },
  })
  if (reserved === null) {
    throw new Error('账本行不存在：读不到账本时不得返回放行语义')
  }

  const now = await txNow(tx)
  const changed = await tx.modelBudgetLedger.updateMany({
    where: { id: input.ledgerId, tenantId: input.tenantId, status: 'RESERVED' },
    data: {
      status: 'SETTLED',
      actualAmount: input.actualAmount,
      costSource: input.costSource,
      finalizedAt: now,
    },
  })
  if (changed.count === 0) {
    return illegalTransition(tx, input)
  }
  return { ok: true, delta: new Prisma.Decimal(input.actualAmount).minus(reserved.reservedAmount) }
}

export interface ReleaseBudgetInput {
  ledgerId: string
  tenantId: string
  /**
   * 只有这两种：数据等级门禁拦下（`GATED`）、客户端在发出前取消
   * （`CANCELLED_BEFORE_DISPATCH`）。客户端超时或挂起**不得**走这条——钱可能真的花了，
   * 那种情况留给 lease 过期回收（T12 不变量）。
   */
  reason: 'GATED' | 'CANCELLED_BEFORE_DISPATCH'
}

/** 释放。只用于调用确实没发生。`RESERVED → RELEASED`。 */
export async function releaseBudget(
  tx: Tx,
  input: ReleaseBudgetInput,
): Promise<{ ok: true } | IllegalTransition> {
  const now = await txNow(tx)
  const changed = await tx.modelBudgetLedger.updateMany({
    where: { id: input.ledgerId, tenantId: input.tenantId, status: 'RESERVED' },
    data: { status: 'RELEASED', releaseReason: input.reason, finalizedAt: now },
  })
  if (changed.count === 0) {
    return illegalTransition(tx, input)
  }
  return { ok: true }
}
