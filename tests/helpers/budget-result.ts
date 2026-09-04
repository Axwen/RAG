import type { Cny, Pool, ReserveBudgetResult } from '@rag/database'

/**
 * 把 `reserveBudget` 的返回联合体收窄成断言想看的那一支。
 *
 * 直接 `expect(result.ok).toBe(true)` 之后 TypeScript 并不知道分支已经定了，而
 * `if (!result.ok) throw` 写在每个用例里会把「这条在验什么」埋进样板代码。形状不对时抛出
 * 带原值的错误，比 `expected undefined to be '0.200000'` 有用得多——并发用例失败时，
 * 第一个要看的就是「另一边到底返回了什么」。
 */

export interface GrantedReserve {
  ledgerId: string
  reservedAmount: Cny
  leaseExpiresAt: Date
  replayed: boolean
}

export function asGranted(result: ReserveBudgetResult | undefined): GrantedReserve {
  if (result === undefined || !result.ok) {
    throw new Error(`期望预扣通过，实际拿到：${JSON.stringify(result)}`)
  }
  return {
    ledgerId: result.ledgerId,
    reservedAmount: result.reservedAmount,
    leaseExpiresAt: result.leaseExpiresAt,
    replayed: result.replayed,
  }
}

/** 单次/日/月三层的拒绝。`layer` 一起返回，用例要断言的正是「撞在哪一层」。 */
export function asLayerRejection(result: ReserveBudgetResult | undefined): {
  layer: 'SINGLE' | 'DAILY' | 'MONTHLY'
  remaining: Cny
} {
  if (result === undefined || result.ok || result.reason !== 'budget.reserve_rejected') {
    throw new Error(
      `期望额度层拒绝（budget.reserve_rejected），实际拿到：${JSON.stringify(result)}`,
    )
  }
  return { layer: result.layer, remaining: result.remaining }
}

/** 池边界拒绝。单独一个原因码，调用方的处理方式与额度不够不同（T12 [事务入口契约]）。 */
export function asPoolRejection(result: ReserveBudgetResult | undefined): {
  pool: Pool
  remaining: Cny
} {
  if (result === undefined || result.ok || result.reason !== 'budget.pool_boundary_rejected') {
    throw new Error(
      `期望池边界拒绝（budget.pool_boundary_rejected），实际拿到：${JSON.stringify(result)}`,
    )
  }
  return { pool: result.pool, remaining: result.remaining }
}
