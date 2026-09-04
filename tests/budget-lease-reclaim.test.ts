import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  Prisma,
  expireBudgetLeases,
  releaseBudget,
  renewBudgetLease,
  reserveBudget,
  settleBudget,
} from '@rag/database'
import type { BudgetLimits, Pool, ReserveBudgetResult } from '@rag/database'
import { asGranted, asLayerRejection } from './helpers/budget-result'
import {
  IntegrationDb,
  answerRunId,
  assertNoForeignReservedRows,
  cny,
  idempotencyKey,
  integrationLimits,
  latch,
} from './helpers/integration-db'

/**
 * lease 过期回收，跑在真 PostgreSQL 上。
 *
 * 回收任务是这套账本里唯一**不带 `tenantId`** 的入口：客户端超时不得释放预扣（钱可能真花了），
 * 所以卡住的行只能等回收。单元层证不了它，因为它整条是一句 `UPDATE … WHERE id IN (SELECT …
 * ORDER BY leaseExpiresAt LIMIT n FOR UPDATE SKIP LOCKED) RETURNING …`：挑行顺序、批量截断、
 * 跳过被锁的行，全在 PostgreSQL 里。
 *
 * 判据时间由调用方给（`expireBudgetLeases(tx, { now, limit })`），所以这里不 sleep：传一个未来的
 * `now` 就能观察「已过期」的行为。代价是**任何**残留的 `RESERVED` 行都会落进候选集，于是每个
 * 用例前先 `assertNoForeignReservedRows`，用例后 `clearLedger`。
 */

const db = new IntegrationDb()
const TX = { timeout: 20_000, maxWait: 10_000 } as const
/** 判据时间推到一小时后：本文件造的每一行都算过期，不用等真实时间。 */
const wayPastDue = (): Date => new Date(Date.now() + 3_600_000)

beforeEach(async () => {
  await assertNoForeignReservedRows(db.prisma, db.ownedTenantIds())
})
afterEach(async () => {
  await db.clearLedger()
})
afterAll(async () => {
  await db.cleanup()
})

function reserve(
  tenantId: string,
  key: string,
  amount: string,
  limits: BudgetLimits,
  leaseSeconds: number,
  pool: Pool = 'INTERACTIVE',
): Promise<ReserveBudgetResult> {
  return db.prisma.$transaction(
    (tx) =>
      reserveBudget(tx, {
        tenantId,
        idempotencyKey: key,
        pool,
        estimatedAmount: cny(amount),
        exchangeRate: cny('1'),
        leaseSeconds,
        owner: { answerRunId: answerRunId() },
        limits,
      }),
    TX,
  )
}

function reap(now: Date, limit: number): Promise<Awaited<ReturnType<typeof expireBudgetLeases>>> {
  return db.prisma.$transaction((tx) => expireBudgetLeases(tx, { now, limit }), TX)
}

const dailyOne: BudgetLimits = { ...integrationLimits, dailyCny: 1 }

describe('回收把 RESERVED 变 EXPIRED 并释放额度', () => {
  it('过期的预扣被回收，额度立刻可以再用', async () => {
    const tenantId = await db.createTenant('reclaim-frees-quota')

    const stuck = asGranted(await reserve(tenantId, idempotencyKey('stuck'), '0.8', dailyOne, 60))
    // 回收之前额度是真的被占着：同一天再要 0.8 撞日限，只剩 0.2。
    const blocked = asLayerRejection(
      await reserve(tenantId, idempotencyKey('blocked'), '0.8', dailyOne, 60),
    )
    expect(blocked.remaining.toFixed(6)).toBe('0.200000')

    const reclaimed = await reap(wayPastDue(), 10)
    expect(reclaimed).toHaveLength(1)
    // 返回值要够写审计（`budget.lease_expired`，`outcome: RECLAIMED`）：租户、池、金额都在里面，
    // 回收任务不必再回查一次。
    expect(reclaimed[0]).toEqual({
      ledgerId: stuck.ledgerId,
      tenantId,
      pool: 'INTERACTIVE',
      reservedAmount: new Prisma.Decimal('0.8'),
    })

    const row = await db.prisma.modelBudgetLedger.findUniqueOrThrow({
      where: { id: stuck.ledgerId },
      select: {
        status: true,
        finalizedAt: true,
        actualAmount: true,
        costSource: true,
        releaseReason: true,
      },
    })
    expect(row.status).toBe('EXPIRED')
    expect(row.finalizedAt).not.toBeNull()
    // 回收不是结算：没有实际费用，也没有释放原因（那是 `releaseBudget` 的字段）。
    expect(row.actualAmount).toBeNull()
    expect(row.costSource).toBeNull()
    expect(row.releaseReason).toBeNull()

    // 额度回来了：同样的 0.8 现在能过。这一条才是「释放额度」的定义，行状态只是它的证据。
    asGranted(await reserve(tenantId, idempotencyKey('after'), '0.8', dailyOne, 60))
  })

  it('判据时间是硬边界：还没到期的行不被回收', async () => {
    const tenantId = await db.createTenant('reclaim-boundary')
    await reserve(tenantId, idempotencyKey('fresh'), '0.1', dailyOne, 60)

    // `leaseExpiresAt <= now` 里的 `now` 由调用方给。传当下时间，60 秒后才到期的行不该动。
    expect(await reap(new Date(), 10)).toEqual([])
    const row = await db.prisma.modelBudgetLedger.findFirstOrThrow({
      where: { tenantId },
      select: { status: true, finalizedAt: true },
    })
    expect(row.status).toBe('RESERVED')
    expect(row.finalizedAt).toBeNull()
  })

  it('终态行不被回收，且终态时间不被改写', async () => {
    const tenantId = await db.createTenant('reclaim-skips-final')

    const toSettle = asGranted(
      await reserve(tenantId, idempotencyKey('settle'), '0.1', dailyOne, 60),
    )
    await db.prisma.$transaction(
      (tx) =>
        settleBudget(tx, {
          ledgerId: toSettle.ledgerId,
          tenantId,
          actualAmount: cny('0.05'),
          costSource: 'PROVIDER',
        }),
      TX,
    )
    const toRelease = asGranted(
      await reserve(tenantId, idempotencyKey('release'), '0.1', dailyOne, 60),
    )
    await db.prisma.$transaction(
      (tx) => releaseBudget(tx, { ledgerId: toRelease.ledgerId, tenantId, reason: 'GATED' }),
      TX,
    )

    const before = await db.prisma.modelBudgetLedger.findMany({
      where: { tenantId },
      select: { id: true, status: true, finalizedAt: true },
      orderBy: { createdAt: 'asc' },
    })

    // 候选集的谓词是 `status = 'RESERVED'`。终态行的 `leaseExpiresAt` 仍然停在过去，
    // 少了那个谓词它们就会被反复「回收」，把已结算的费用抹掉。
    expect(await reap(wayPastDue(), 10)).toEqual([])

    const after = await db.prisma.modelBudgetLedger.findMany({
      where: { tenantId },
      select: { id: true, status: true, finalizedAt: true },
      orderBy: { createdAt: 'asc' },
    })
    expect(after).toEqual(before)
    expect(after.map((row) => row.status)).toEqual(['SETTLED', 'RELEASED'])
  })
})

describe('批次的挑行规则', () => {
  it('按 leaseExpiresAt 升序、被 limit 截断，剩下的下一轮回收', async () => {
    const tenantId = await db.createTenant('reclaim-order')
    // lease 长度 1/2/3 秒，逐个创建：三行的 leaseExpiresAt 严格递增（秒级差远大于创建间隔的毫秒差）。
    const first = asGranted(await reserve(tenantId, idempotencyKey('t1'), '0.1', dailyOne, 1))
    const second = asGranted(await reserve(tenantId, idempotencyKey('t2'), '0.1', dailyOne, 2))
    const third = asGranted(await reserve(tenantId, idempotencyKey('t3'), '0.1', dailyOne, 3))

    // 先回收最早到期的两条。顺序不是无所谓的：卡最久的行先还额度，才不会让一批新过期的行
    // 把老行挤到永远轮不到。
    const batch = await reap(wayPastDue(), 2)
    expect(batch.map((row) => row.ledgerId)).toEqual([first.ledgerId, second.ledgerId])

    const rest = await reap(wayPastDue(), 2)
    expect(rest.map((row) => row.ledgerId)).toEqual([third.ledgerId])

    // 幂等：没有候选行时返回空批次，不报错——回收任务是定时跑的，空跑必须是正常路径。
    expect(await reap(wayPastDue(), 2)).toEqual([])
  })

  it('被别的事务锁住的行被跳过，锁一放就在下一轮回收', async () => {
    const tenantId = await db.createTenant('reclaim-skip-locked')
    const locked = asGranted(await reserve(tenantId, idempotencyKey('locked'), '0.1', dailyOne, 1))
    const free = asGranted(await reserve(tenantId, idempotencyKey('free'), '0.1', dailyOne, 2))

    // 用闸门而不是 setTimeout：持锁事务先宣布「我拿到锁了」，回收才开跑。靠睡眠猜时序
    // 会在 CI 上变成偶发失败。
    const held = latch()
    const release = latch()
    const holder = db.prisma.$transaction(async (tx) => {
      await tx.$queryRaw(
        Prisma.sql`SELECT "id" FROM "model_budget_ledger" WHERE "id" = ${locked.ledgerId}::uuid FOR UPDATE`,
      )
      held.open()
      await release.wait
    }, TX)

    try {
      await held.wait
      // `SKIP LOCKED` 的意义在这里：回收任务不会卡在别人的行锁上等，它拿走剩下的那条就走。
      // 少了它，多实例回收会互相阻塞，一个慢事务就能让整条回收链停摆。
      const batch = await reap(wayPastDue(), 10)
      expect(batch.map((row) => row.ledgerId)).toEqual([free.ledgerId])
    } finally {
      release.open()
      await holder
    }

    // 跳过不是丢弃：锁释放后同一行照样被回收。
    const second = await reap(wayPastDue(), 10)
    expect(second.map((row) => row.ledgerId)).toEqual([locked.ledgerId])
  })
})

describe('续租把行移出回收窗口', () => {
  it('续租后按新的 leaseExpiresAt 判定，renewCount 递增', async () => {
    const tenantId = await db.createTenant('renew-moves-window')
    const row = asGranted(await reserve(tenantId, idempotencyKey('long-call'), '0.1', dailyOne, 5))

    const renewed = await db.prisma.$transaction(
      (tx) =>
        renewBudgetLease(tx, {
          ledgerId: row.ledgerId,
          tenantId,
          leaseSeconds: 60,
          limits: dailyOne,
        }),
      TX,
    )
    if (!renewed.ok) {
      throw new Error(`期望续租成功，实际拿到：${JSON.stringify(renewed)}`)
    }
    expect(renewed.leaseExpiresAt.getTime()).toBeGreaterThan(row.leaseExpiresAt.getTime())

    // 判据推到原到期时间之后一秒：没续租的话这行早该被回收。这就是「长调用要显式续租」
    // 的另一面——续过租的行不该因为原 lease 到点而被抢走。
    const atOldDeadline = new Date(row.leaseExpiresAt.getTime() + 1_000)
    expect(await reap(atOldDeadline, 10)).toEqual([])

    const stored = await db.prisma.modelBudgetLedger.findUniqueOrThrow({
      where: { id: row.ledgerId },
      select: { status: true, renewCount: true, leaseExpiresAt: true },
    })
    expect(stored.status).toBe('RESERVED')
    expect(stored.renewCount).toBe(1)
    expect(stored.leaseExpiresAt.getTime()).toBe(renewed.leaseExpiresAt.getTime())

    // 续租只是推后，不是豁免：新到期时间过了照样回收。
    const atNewDeadline = new Date(renewed.leaseExpiresAt.getTime() + 1_000)
    const reclaimed = await reap(atNewDeadline, 10)
    expect(reclaimed.map((entry) => entry.ledgerId)).toEqual([row.ledgerId])
  })

  it('终态行续不了租：回收已经发生就不能反悔', async () => {
    const tenantId = await db.createTenant('renew-after-reclaim')
    const row = asGranted(await reserve(tenantId, idempotencyKey('reclaimed'), '0.1', dailyOne, 1))
    await reap(wayPastDue(), 10)

    // 续租的 `where` 里带 `status: 'RESERVED'`，所以这里落空而不是把 `EXPIRED` 行复活。
    const renewed = await db.prisma.$transaction(
      (tx) =>
        renewBudgetLease(tx, {
          ledgerId: row.ledgerId,
          tenantId,
          leaseSeconds: 60,
          limits: dailyOne,
        }),
      TX,
    )
    expect(renewed).toEqual({ ok: false, reason: 'ILLEGAL_TRANSITION' })
    const stored = await db.prisma.modelBudgetLedger.findUniqueOrThrow({
      where: { id: row.ledgerId },
      select: { status: true, renewCount: true },
    })
    expect(stored.status).toBe('EXPIRED')
    expect(stored.renewCount).toBe(0)
  })
})
