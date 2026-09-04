import { describe, expect, it } from 'vitest'
import { resourceLimitsDefaults } from '@rag/config'
import { Prisma } from '../src/generated/prisma/client'
import { releaseBudget, settleBudget } from '../src/budget/finalize'
import { expireBudgetLeases, renewBudgetLease } from '../src/budget/lease'
import { reserveBudget } from '../src/budget/reserve'
import type { BudgetLimits } from '../src/budget/types'
import { createFakeTx, fakeTenantId, ledgerRow } from './fake-tx'

/**
 * 五条事务入口的判定逻辑（T12 [事务入口契约]）。
 *
 * 分层是票据自己划的：这里覆盖「结算差额计算；状态机非法转移被拒」这一侧，也就是四层 CAS 的
 * 层序、拒绝原因码与 `remaining` 口径、续租两道上限、入参校验。真实并发（同时预扣到日限边界只有
 * 一个成功）、幂等键撞唯一约束、lease 回收与「审计写失败回滚业务事务」跑在集成层的真实
 * PostgreSQL 上——那些是 advisory lock、唯一约束与状态机触发器的事，假事务里不存在。
 */

const tenantId = fakeTenantId
const answerRunId = '018f0000-0000-7000-8000-0000000000a1'
const cny = (value: string): Prisma.Decimal => new Prisma.Decimal(value)

/**
 * 很小的上限，让边界用一位小数就能撞到。
 *
 * 不用默认值（单次 5 / 日 16 / 月 500）造边界：那需要在假账里堆到 ¥16，读的人分不清
 * 「这条断言在验哪一层」。三池之和等于月度上限这条口径照旧保持。
 */
const limits: BudgetLimits = {
  singleCallCny: 1,
  dailyCny: 2,
  monthlyCny: 10,
  pools: { interactive: 6, evaluation: 3, reserve: 1 },
  lease: { defaultSeconds: 60, maxRenewSeconds: 60, maxTotalSeconds: 600 },
}

const reserveInput = {
  tenantId,
  idempotencyKey: 'key-new',
  pool: 'INTERACTIVE' as const,
  estimatedAmount: cny('0.5'),
  exchangeRate: cny('7.2'),
  owner: { answerRunId },
  limits,
}

describe('reserveBudget', () => {
  it('通过四层后写 RESERVED，并按事务时钟推 lease', async () => {
    const now = new Date('2026-09-03T12:00:00.000Z')
    const { tx, rows } = createFakeTx({ now })

    const result = await reserveBudget(tx, reserveInput)

    expect(result).toMatchObject({ ok: true, replayed: false })
    expect(rows).toHaveLength(1)
    const row = rows[0]
    expect(row?.status).toBe('RESERVED')
    expect(row?.reservedAmount.toString()).toBe('0.5')
    // 汇率与金额分开记录，不把「当时的汇率」折进金额里。
    expect(row?.exchangeRate.toString()).toBe('7.2')
    expect(row?.answerRunId).toBe(answerRunId)
    expect(row?.jobId).toBeNull()
    expect(row?.leaseExpiresAt.toISOString()).toBe('2026-09-03T12:01:00.000Z')
  })

  it('createdAt 用事务时钟，不用 Prisma 的客户端时钟', async () => {
    const now = new Date('2026-09-03T12:00:00.000Z')
    const { tx, rows } = createFakeTx({ now })

    await reserveBudget(tx, reserveInput)

    // 这一列就是 committedAmounts 求和的窗口列。省略它会让 Prisma 在客户端生成时间
    // （假事务把这种情况填成 now + 5s），于是 CAS 按事务时钟校验窗口、行落在别的时刻上——
    // 跨零点的那一次调用因此能绕过日限。
    expect(rows[0]?.createdAt.toISOString()).toBe('2026-09-03T12:00:00.000Z')
  })

  it('advisory lock 在幂等查询之前', async () => {
    const { tx, calls } = createFakeTx()

    await reserveBudget(tx, reserveInput)

    // 反过来的话，两个同键请求可能都查不到行，一个插入成功另一个撞唯一约束抛异常——
    // 重放本该安静返回同一行。
    expect(calls.indexOf('lock')).toBeLessThan(calls.indexOf('findUnique'))
  })

  it('幂等键命中时返回那一行，不新增也不重复扣款', async () => {
    const existing = ledgerRow({
      id: 'row-existing',
      idempotencyKey: 'key-new',
      reservedAmount: cny('0.25'),
    })
    const { tx, rows } = createFakeTx({ rows: [existing] })

    const result = await reserveBudget(tx, reserveInput)

    expect(result).toMatchObject({ ok: true, replayed: true, ledgerId: 'row-existing' })
    expect(result.ok && result.reservedAmount.toString()).toBe('0.25')
    expect(rows).toHaveLength(1)
  })

  it('已结算的调用重放同样不再扣一次', async () => {
    const settled = ledgerRow({
      id: 'row-settled',
      idempotencyKey: 'key-new',
      status: 'SETTLED',
      actualAmount: cny('0.3'),
      costSource: 'PROVIDER',
      finalizedAt: new Date('2026-09-03T12:00:30.000Z'),
    })
    const { tx, rows } = createFakeTx({ rows: [settled] })

    const result = await reserveBudget(tx, reserveInput)

    expect(result).toMatchObject({ ok: true, replayed: true, ledgerId: 'row-settled' })
    expect(rows).toHaveLength(1)
  })

  it('第一层：单次超限返回 SINGLE，remaining 是单次上限本身', async () => {
    const { tx, rows, calls } = createFakeTx()

    const result = await reserveBudget(tx, { ...reserveInput, estimatedAmount: cny('1.5') })

    expect(result).toEqual({
      ok: false,
      reason: 'budget.reserve_rejected',
      layer: 'SINGLE',
      remaining: cny('1'),
    })
    expect(rows).toHaveLength(0)
    // 单次判定不读库：一次调用要么在单次上限内，要么不在。
    expect(calls).not.toContain('committed')
  })

  it('第二层：日限用跨池求和，remaining 是还剩多少', async () => {
    const { tx, rows } = createFakeTx({
      rows: [
        ledgerRow({ id: 'row-1', idempotencyKey: 'k1', reservedAmount: cny('1.2') }),
        // 评测池花掉的钱同样算进当日总额。
        ledgerRow({
          id: 'row-2',
          idempotencyKey: 'k2',
          pool: 'EVALUATION',
          reservedAmount: cny('0.5'),
        }),
      ],
    })

    const result = await reserveBudget(tx, { ...reserveInput, estimatedAmount: cny('0.4') })

    expect(result).toEqual({
      ok: false,
      reason: 'budget.reserve_rejected',
      layer: 'DAILY',
      remaining: cny('0.3'),
    })
    expect(rows).toHaveLength(2)
  })

  it('刚好等于日限放行，超出一分即拒', async () => {
    const used = () => [
      ledgerRow({ id: 'row-1', idempotencyKey: 'k1', reservedAmount: cny('1.5') }),
    ]

    const exact = createFakeTx({ rows: used() })
    await expect(
      reserveBudget(exact.tx, { ...reserveInput, estimatedAmount: cny('0.5') }),
    ).resolves.toMatchObject({ ok: true })

    const over = createFakeTx({ rows: used() })
    await expect(
      reserveBudget(over.tx, { ...reserveInput, estimatedAmount: cny('0.500001') }),
    ).resolves.toMatchObject({ ok: false, layer: 'DAILY' })
  })

  it('RELEASED 与 EXPIRED 不占额度，SETTLED 按实际值算', async () => {
    const { tx } = createFakeTx({
      rows: [
        ledgerRow({
          id: 'row-1',
          idempotencyKey: 'k1',
          status: 'RELEASED',
          reservedAmount: cny('1.9'),
          releaseReason: 'GATED',
        }),
        ledgerRow({
          id: 'row-2',
          idempotencyKey: 'k2',
          status: 'EXPIRED',
          reservedAmount: cny('1.9'),
        }),
        // 预扣 1.9、实际只花 0.1：占额按 0.1 算，多占的随结算自动还回。
        ledgerRow({
          id: 'row-3',
          idempotencyKey: 'k3',
          status: 'SETTLED',
          reservedAmount: cny('1.9'),
          actualAmount: cny('0.1'),
          costSource: 'PROVIDER',
        }),
      ],
    })

    await expect(
      reserveBudget(tx, { ...reserveInput, estimatedAmount: cny('0.9') }),
    ).resolves.toMatchObject({ ok: true })
  })

  it('上个月的行不算进本月窗口', async () => {
    const { tx } = createFakeTx({
      now: new Date('2026-09-03T12:00:00.000Z'),
      rows: [
        ledgerRow({
          id: 'row-old',
          idempotencyKey: 'k-old',
          reservedAmount: cny('9.5'),
          createdAt: new Date('2026-08-31T23:59:59.999Z'),
          leaseExpiresAt: new Date('2026-09-01T00:00:59.999Z'),
        }),
      ],
    })

    await expect(reserveBudget(tx, reserveInput)).resolves.toMatchObject({ ok: true })
  })

  it('第三层：月限超出返回 MONTHLY', async () => {
    const { tx } = createFakeTx({
      now: new Date('2026-09-20T12:00:00.000Z'),
      rows: [
        // 当月早些天的用量：不在当日窗口里，所以日限判定看不到它。
        ledgerRow({
          id: 'row-1',
          idempotencyKey: 'k1',
          reservedAmount: cny('9.8'),
          createdAt: new Date('2026-09-01T00:00:00.000Z'),
          leaseExpiresAt: new Date('2026-09-01T00:01:00.000Z'),
        }),
      ],
    })

    const result = await reserveBudget(tx, { ...reserveInput, estimatedAmount: cny('0.5') })

    expect(result).toEqual({
      ok: false,
      reason: 'budget.reserve_rejected',
      layer: 'MONTHLY',
      remaining: cny('0.2'),
    })
  })

  it('第四层：池月度上限用独立原因码，带 pool', async () => {
    const { tx } = createFakeTx({
      now: new Date('2026-09-20T12:00:00.000Z'),
      rows: [
        ledgerRow({
          id: 'row-1',
          idempotencyKey: 'k1',
          pool: 'RESERVE',
          reservedAmount: cny('0.8'),
          createdAt: new Date('2026-09-01T00:00:00.000Z'),
          leaseExpiresAt: new Date('2026-09-01T00:01:00.000Z'),
        }),
      ],
    })

    // 池满是隔离边界（评测负载不得吃掉交互池），不是租户没钱了，所以处理方式不同。
    const result = await reserveBudget(tx, {
      ...reserveInput,
      pool: 'RESERVE',
      estimatedAmount: cny('0.5'),
    })

    expect(result).toEqual({
      ok: false,
      reason: 'budget.pool_boundary_rejected',
      pool: 'RESERVE',
      remaining: cny('0.2'),
    })
  })

  it('层序：同时超单次与日限时报 SINGLE', async () => {
    const { tx } = createFakeTx({
      rows: [ledgerRow({ id: 'row-1', idempotencyKey: 'k1', reservedAmount: cny('1.9') })],
    })

    await expect(
      reserveBudget(tx, { ...reserveInput, estimatedAmount: cny('1.5') }),
    ).resolves.toMatchObject({ layer: 'SINGLE' })
  })

  it('remaining 不出现负数', async () => {
    const { tx } = createFakeTx({
      rows: [ledgerRow({ id: 'row-1', idempotencyKey: 'k1', reservedAmount: cny('2.5') })],
    })

    const result = await reserveBudget(tx, reserveInput)

    // 库里已经超了（上限被下调过）时，拒绝响应里出现负余额只会让读的人以为账错了。
    expect(result).toMatchObject({ layer: 'DAILY', remaining: cny('0') })
  })

  it('不传 limits 时取配置默认值', async () => {
    const { tx, rows } = createFakeTx()

    await reserveBudget(tx, {
      tenantId,
      idempotencyKey: 'key-new',
      pool: 'INTERACTIVE',
      estimatedAmount: cny('4.9'),
      exchangeRate: cny('7.2'),
      owner: { answerRunId },
    })

    // 4.9 超过测试用的 singleCallCny=1，但在默认的 5 以内。
    expect(rows).toHaveLength(1)
    expect(rows[0]?.leaseExpiresAt.getTime()).toBe(
      rows[0]!.createdAt.getTime() + resourceLimitsDefaults.budget.lease.defaultSeconds * 1000,
    )
  })

  it('金额为负、汇率非正、lease 形状错都是抛而不是返回 ok:false', async () => {
    const { tx } = createFakeTx()

    // 这些是调用方的编程错误：返回 ok:false 会让「参数写错」和「预算真的不够」长得一样。
    await expect(
      reserveBudget(tx, { ...reserveInput, estimatedAmount: cny('-0.01') }),
    ).rejects.toThrow('预扣金额为负')
    // 汇率 0 会把所有折算金额抹成 0，等于关掉门禁；Decimal 的 isPositive() 对 0 返回 true，
    // 所以这一条必须用比较写。
    await expect(reserveBudget(tx, { ...reserveInput, exchangeRate: cny('0') })).rejects.toThrow(
      '汇率必须为正',
    )
    await expect(reserveBudget(tx, { ...reserveInput, exchangeRate: cny('-7.2') })).rejects.toThrow(
      '汇率必须为正',
    )
    await expect(reserveBudget(tx, { ...reserveInput, leaseSeconds: 0 })).rejects.toThrow(
      'lease 时长必须是正整数秒',
    )
    await expect(reserveBudget(tx, { ...reserveInput, leaseSeconds: 1.5 })).rejects.toThrow(
      'lease 时长必须是正整数秒',
    )
  })

  it('初始 lease 超过总时长上限直接抛', async () => {
    const { tx } = createFakeTx()

    // 「不得靠调大 lease 默认值掩盖没人续租」这条不变量的落点。
    await expect(reserveBudget(tx, { ...reserveInput, leaseSeconds: 601 })).rejects.toThrow(
      '超过配置上限',
    )
  })

  it('归属必须恰好一个，且在取锁之前校验', async () => {
    const both = createFakeTx()
    await expect(
      reserveBudget(both.tx, {
        ...reserveInput,
        owner: { answerRunId, jobId: answerRunId } as unknown as { answerRunId: string },
      }),
    ).rejects.toThrow('恰好是 answerRunId 或 jobId 之一')

    const neither = createFakeTx()
    await expect(
      reserveBudget(neither.tx, {
        ...reserveInput,
        owner: {} as unknown as { jobId: string },
      }),
    ).rejects.toThrow('恰好是 answerRunId 或 jobId 之一')
    // 形状错的请求不该先占住租户的锁。
    expect(neither.calls).not.toContain('lock')
  })

  it('jobId 归属同样写得进去', async () => {
    const { tx, rows } = createFakeTx()

    await reserveBudget(tx, { ...reserveInput, owner: { jobId: answerRunId } })

    expect(rows[0]?.jobId).toBe(answerRunId)
    expect(rows[0]?.answerRunId).toBeNull()
  })

  it('租户 A 的用量不影响租户 B（判定谓词带 tenantId）', async () => {
    const { tx } = createFakeTx({
      rows: [
        ledgerRow({
          id: 'row-other',
          tenantId: '018f0000-0000-7000-8000-0000000000ff',
          idempotencyKey: 'key-new',
          reservedAmount: cny('9.9'),
        }),
      ],
    })

    // 同一个幂等键、另一个租户：既不该命中重放，也不该占用本租户的额度。
    await expect(reserveBudget(tx, reserveInput)).resolves.toMatchObject({
      ok: true,
      replayed: false,
    })
  })
})

describe('settleBudget', () => {
  it('RESERVED → SETTLED，写实际值与来源，返回差额', async () => {
    const now = new Date('2026-09-03T12:00:30.000Z')
    const { tx, rows } = createFakeTx({
      now,
      rows: [ledgerRow({ reservedAmount: cny('0.5') })],
    })

    const result = await settleBudget(tx, {
      ledgerId: 'row-1',
      tenantId,
      actualAmount: cny('0.42'),
      costSource: 'PROVIDER',
    })

    expect(result).toEqual({ ok: true, delta: cny('-0.08') })
    expect(rows[0]?.status).toBe('SETTLED')
    expect(rows[0]?.actualAmount?.toString()).toBe('0.42')
    expect(rows[0]?.costSource).toBe('PROVIDER')
    expect(rows[0]?.finalizedAt?.toISOString()).toBe(now.toISOString())
  })

  it('差额为正说明估低了，为零也照样返回', async () => {
    const high = createFakeTx({ rows: [ledgerRow({ reservedAmount: cny('0.5') })] })
    await expect(
      settleBudget(high.tx, {
        ledgerId: 'row-1',
        tenantId,
        actualAmount: cny('0.63'),
        costSource: 'PROVIDER',
      }),
    ).resolves.toEqual({ ok: true, delta: cny('0.13') })

    const exact = createFakeTx({ rows: [ledgerRow({ reservedAmount: cny('0.5') })] })
    await expect(
      settleBudget(exact.tx, {
        ledgerId: 'row-1',
        tenantId,
        actualAmount: cny('0.5'),
        costSource: 'PROVIDER',
      }),
    ).resolves.toEqual({ ok: true, delta: cny('0') })
  })

  it('供应商没返回 cost 时记 ESTIMATED', async () => {
    const { tx, rows } = createFakeTx({ rows: [ledgerRow({ reservedAmount: cny('0.5') })] })

    await settleBudget(tx, {
      ledgerId: 'row-1',
      tenantId,
      actualAmount: cny('0.5'),
      costSource: 'ESTIMATED',
    })

    // 差额本身是审计对象：ESTIMATED 时即使 delta 为 0 也要写 budget.settlement_delta。
    expect(rows[0]?.costSource).toBe('ESTIMATED')
  })

  it('重复结算返回 ILLEGAL_TRANSITION 并带当前状态', async () => {
    const { tx, rows } = createFakeTx({
      rows: [
        ledgerRow({
          status: 'SETTLED',
          actualAmount: cny('0.42'),
          costSource: 'PROVIDER',
          finalizedAt: new Date('2026-09-03T12:00:30.000Z'),
        }),
      ],
    })

    const result = await settleBudget(tx, {
      ledgerId: 'row-1',
      tenantId,
      actualAmount: cny('0.9'),
      costSource: 'PROVIDER',
    })

    // 状态谓词写在 where 里，所以库里的状态机触发器不会被碰到——调用方拿到的是
    // ILLEGAL_TRANSITION，不是一个 check_violation 原文。
    expect(result).toEqual({ ok: false, reason: 'ILLEGAL_TRANSITION', status: 'SETTLED' })
    expect(rows[0]?.actualAmount?.toString()).toBe('0.42')
  })

  it('已释放的行不能结算', async () => {
    const { tx } = createFakeTx({
      rows: [ledgerRow({ status: 'RELEASED', releaseReason: 'GATED' })],
    })

    await expect(
      settleBudget(tx, {
        ledgerId: 'row-1',
        tenantId,
        actualAmount: cny('0.1'),
        costSource: 'PROVIDER',
      }),
    ).resolves.toEqual({ ok: false, reason: 'ILLEGAL_TRANSITION', status: 'RELEASED' })
  })

  it('行不存在时抛，不返回放行语义', async () => {
    const { tx } = createFakeTx()

    await expect(
      settleBudget(tx, {
        ledgerId: 'row-missing',
        tenantId,
        actualAmount: cny('0.1'),
        costSource: 'PROVIDER',
      }),
    ).rejects.toThrow('账本行不存在')
  })

  it('按 id 查必须带租户谓词', async () => {
    const { tx } = createFakeTx({ rows: [ledgerRow()] })

    await expect(
      settleBudget(tx, {
        ledgerId: 'row-1',
        tenantId: '018f0000-0000-7000-8000-0000000000ff',
        actualAmount: cny('0.1'),
        costSource: 'PROVIDER',
      }),
    ).rejects.toThrow('账本行不存在')
  })

  it('结算金额为负直接抛', async () => {
    const { tx } = createFakeTx({ rows: [ledgerRow()] })

    await expect(
      settleBudget(tx, {
        ledgerId: 'row-1',
        tenantId,
        actualAmount: cny('-0.01'),
        costSource: 'PROVIDER',
      }),
    ).rejects.toThrow('结算金额为负')
  })
})

describe('releaseBudget', () => {
  it('RESERVED → RELEASED 并记原因', async () => {
    const now = new Date('2026-09-03T12:00:05.000Z')
    const { tx, rows } = createFakeTx({ now, rows: [ledgerRow()] })

    await expect(
      releaseBudget(tx, { ledgerId: 'row-1', tenantId, reason: 'GATED' }),
    ).resolves.toEqual({ ok: true })
    expect(rows[0]?.status).toBe('RELEASED')
    expect(rows[0]?.releaseReason).toBe('GATED')
    expect(rows[0]?.finalizedAt?.toISOString()).toBe(now.toISOString())
  })

  it('发出前取消是另一个原因码', async () => {
    const { tx, rows } = createFakeTx({ rows: [ledgerRow()] })

    await releaseBudget(tx, {
      ledgerId: 'row-1',
      tenantId,
      reason: 'CANCELLED_BEFORE_DISPATCH',
    })

    expect(rows[0]?.releaseReason).toBe('CANCELLED_BEFORE_DISPATCH')
  })

  it('重复释放返回 ILLEGAL_TRANSITION', async () => {
    const { tx } = createFakeTx({
      rows: [ledgerRow({ status: 'RELEASED', releaseReason: 'GATED' })],
    })

    await expect(
      releaseBudget(tx, { ledgerId: 'row-1', tenantId, reason: 'GATED' }),
    ).resolves.toEqual({ ok: false, reason: 'ILLEGAL_TRANSITION', status: 'RELEASED' })
  })

  it('lease 已过期回收成 EXPIRED 的行不能再释放', async () => {
    const { tx } = createFakeTx({ rows: [ledgerRow({ status: 'EXPIRED' })] })

    // 客户端超时或挂起不得走释放这条路——钱可能真的花了，那种情况只能等回收。
    await expect(
      releaseBudget(tx, { ledgerId: 'row-1', tenantId, reason: 'CANCELLED_BEFORE_DISPATCH' }),
    ).resolves.toEqual({ ok: false, reason: 'ILLEGAL_TRANSITION', status: 'EXPIRED' })
  })

  it('行不存在时抛', async () => {
    const { tx } = createFakeTx()

    await expect(
      releaseBudget(tx, { ledgerId: 'row-missing', tenantId, reason: 'GATED' }),
    ).rejects.toThrow('账本行不存在')
  })
})

describe('renewBudgetLease', () => {
  it('只推 leaseExpiresAt，不改状态，renewCount 递增', async () => {
    const now = new Date('2026-09-03T12:00:45.000Z')
    const { tx, rows } = createFakeTx({ now, rows: [ledgerRow()] })

    const result = await renewBudgetLease(tx, {
      ledgerId: 'row-1',
      tenantId,
      leaseSeconds: 60,
      limits,
    })

    // 续租不是「四条」里的一条：状态与 finalizedAt 都不动。
    expect(result).toEqual({ ok: true, leaseExpiresAt: new Date('2026-09-03T12:01:45.000Z') })
    expect(rows[0]?.status).toBe('RESERVED')
    expect(rows[0]?.finalizedAt).toBeNull()
    expect(rows[0]?.leaseExpiresAt.toISOString()).toBe('2026-09-03T12:01:45.000Z')
    expect(rows[0]?.renewCount).toBe(1)
  })

  it('新的 leaseExpiresAt 从事务时钟起算，不是从旧的过期时间接着算', async () => {
    // 否则一次晚到的续租会把 lease 推到「本该早就回收」的将来，回收任务永远抓不到这一行。
    const now = new Date('2026-09-03T12:02:00.000Z')
    const { tx, rows } = createFakeTx({
      now,
      rows: [ledgerRow({ leaseExpiresAt: new Date('2026-09-03T12:01:00.000Z') })],
    })

    await renewBudgetLease(tx, { ledgerId: 'row-1', tenantId, leaseSeconds: 60, limits })

    expect(rows[0]?.leaseExpiresAt.toISOString()).toBe('2026-09-03T12:03:00.000Z')
  })

  it('单次续租时长超 maxRenewSeconds 即拒', async () => {
    const { tx, rows } = createFakeTx({ rows: [ledgerRow()] })

    await expect(
      renewBudgetLease(tx, { ledgerId: 'row-1', tenantId, leaseSeconds: 61, limits }),
    ).resolves.toEqual({ ok: false, reason: 'RENEW_LIMIT_EXCEEDED' })
    expect(rows[0]?.renewCount).toBe(0)
  })

  it('单次上限在读行之前就判，行不存在也照样是 RENEW_LIMIT_EXCEEDED', async () => {
    // 要求超上限本身就该被拒，与那一行是什么状态无关。
    const { tx } = createFakeTx()

    await expect(
      renewBudgetLease(tx, { ledgerId: 'row-missing', tenantId, leaseSeconds: 601, limits }),
    ).resolves.toEqual({ ok: false, reason: 'RENEW_LIMIT_EXCEEDED' })
  })

  it('总时长以 createdAt 起算：踩到边界放过，越过一点就拒', async () => {
    // 用总时长而不是续租次数，是因为次数拦不住「每次续 60 秒续二十次」。
    const exact = createFakeTx({
      now: new Date('2026-09-03T12:09:30.000Z'),
      rows: [ledgerRow()],
    })
    await expect(
      renewBudgetLease(exact.tx, { ledgerId: 'row-1', tenantId, leaseSeconds: 30, limits }),
    ).resolves.toEqual({ ok: true, leaseExpiresAt: new Date('2026-09-03T12:10:00.000Z') })

    const over = createFakeTx({
      now: new Date('2026-09-03T12:09:30.000Z'),
      rows: [ledgerRow()],
    })
    await expect(
      renewBudgetLease(over.tx, { ledgerId: 'row-1', tenantId, leaseSeconds: 31, limits }),
    ).resolves.toEqual({ ok: false, reason: 'RENEW_LIMIT_EXCEEDED' })
    expect(over.rows[0]?.leaseExpiresAt.toISOString()).toBe('2026-09-03T12:01:00.000Z')
  })

  it('renewCount 递增但不是判据：续到第 9 次仍然只看总时长', async () => {
    const { tx, rows } = createFakeTx({
      now: new Date('2026-09-03T12:08:00.000Z'),
      rows: [ledgerRow({ renewCount: 8, leaseExpiresAt: new Date('2026-09-03T12:08:30.000Z') })],
    })

    await expect(
      renewBudgetLease(tx, { ledgerId: 'row-1', tenantId, leaseSeconds: 60, limits }),
    ).resolves.toEqual({ ok: true, leaseExpiresAt: new Date('2026-09-03T12:09:00.000Z') })
    expect(rows[0]?.renewCount).toBe(9)
  })

  it('省略 limits 时上限取配置默认值', async () => {
    const { tx } = createFakeTx({ rows: [ledgerRow()] })

    await expect(
      renewBudgetLease(tx, { ledgerId: 'row-1', tenantId, leaseSeconds: 61 }),
    ).resolves.toEqual({ ok: false, reason: 'RENEW_LIMIT_EXCEEDED' })
    await expect(
      renewBudgetLease(tx, { ledgerId: 'row-1', tenantId, leaseSeconds: 60 }),
    ).resolves.toEqual({ ok: true, leaseExpiresAt: new Date('2026-09-03T12:01:00.000Z') })
  })

  it('终态行不能续租', async () => {
    for (const status of ['SETTLED', 'RELEASED', 'EXPIRED'] as const) {
      const { tx, rows } = createFakeTx({
        rows: [
          ledgerRow({
            status,
            ...(status === 'SETTLED'
              ? { actualAmount: cny('0.4'), costSource: 'PROVIDER' as const }
              : {}),
            ...(status === 'RELEASED' ? { releaseReason: 'GATED' as const } : {}),
          }),
        ],
      })

      // 回收或结算已经把行改成终态之后，一次晚到的续租必须落空而不是复活它。
      await expect(
        renewBudgetLease(tx, { ledgerId: 'row-1', tenantId, leaseSeconds: 60, limits }),
      ).resolves.toEqual({ ok: false, reason: 'ILLEGAL_TRANSITION' })
      expect(rows[0]?.renewCount).toBe(0)
    }
  })

  it('行不存在时抛，另一个租户的行同样读不到', async () => {
    const missing = createFakeTx()
    await expect(
      renewBudgetLease(missing.tx, {
        ledgerId: 'row-missing',
        tenantId,
        leaseSeconds: 60,
        limits,
      }),
    ).rejects.toThrow('账本行不存在')

    const otherTenant = createFakeTx({ rows: [ledgerRow()] })
    await expect(
      renewBudgetLease(otherTenant.tx, {
        ledgerId: 'row-1',
        tenantId: '018f0000-0000-7000-8000-0000000000ff',
        leaseSeconds: 60,
        limits,
      }),
    ).rejects.toThrow('账本行不存在')
  })

  it('续租时长必须是正整数秒', async () => {
    const { tx } = createFakeTx({ rows: [ledgerRow()] })

    for (const leaseSeconds of [0, -1, 1.5]) {
      await expect(
        renewBudgetLease(tx, { ledgerId: 'row-1', tenantId, leaseSeconds, limits }),
      ).rejects.toThrow('续租时长必须是正整数秒')
    }
  })
})

describe('expireBudgetLeases', () => {
  it('把过期未结算的 RESERVED 变 EXPIRED，返回逐条审计需要的字段', async () => {
    const now = new Date('2026-09-03T12:05:00.000Z')
    const { tx, rows } = createFakeTx({
      now,
      rows: [
        ledgerRow({
          id: 'row-expired',
          reservedAmount: cny('0.75'),
          pool: 'EVALUATION',
          leaseExpiresAt: new Date('2026-09-03T12:01:00.000Z'),
        }),
      ],
    })

    const reclaimed = await expireBudgetLeases(tx, { now, limit: 10 })

    expect(reclaimed).toHaveLength(1)
    expect(reclaimed[0]?.ledgerId).toBe('row-expired')
    expect(reclaimed[0]?.tenantId).toBe(tenantId)
    expect(reclaimed[0]?.pool).toBe('EVALUATION')
    // 金额必须是 Decimal 而不是驱动给的字符串：调用方要拿它写 budget.lease_expired 的审计详情。
    expect(reclaimed[0]?.reservedAmount).toBeInstanceOf(Prisma.Decimal)
    expect(reclaimed[0]?.reservedAmount.toString()).toBe('0.75')
    expect(rows[0]?.status).toBe('EXPIRED')
    expect(rows[0]?.finalizedAt?.toISOString()).toBe(now.toISOString())
  })

  it('lease 刚好到点的行算过期，还没到的不动', async () => {
    const now = new Date('2026-09-03T12:01:00.000Z')
    const { tx, rows } = createFakeTx({
      now,
      rows: [
        ledgerRow({ id: 'row-due', leaseExpiresAt: new Date('2026-09-03T12:01:00.000Z') }),
        ledgerRow({ id: 'row-alive', leaseExpiresAt: new Date('2026-09-03T12:01:00.001Z') }),
      ],
    })

    const reclaimed = await expireBudgetLeases(tx, { now, limit: 10 })

    expect(reclaimed.map((row) => row.ledgerId)).toEqual(['row-due'])
    expect(rows[1]?.status).toBe('RESERVED')
    expect(rows[1]?.finalizedAt).toBeNull()
  })

  it('终态行不会被回收，哪怕 leaseExpiresAt 早就过了', async () => {
    // 结算完的行 leaseExpiresAt 不会被清空，只靠时间挑行会把已经花掉的钱重新「还」一遍。
    const now = new Date('2026-09-03T13:00:00.000Z')
    const { tx, rows } = createFakeTx({
      now,
      rows: [
        ledgerRow({
          id: 'row-settled',
          status: 'SETTLED',
          actualAmount: cny('0.9'),
          costSource: 'PROVIDER',
          finalizedAt: new Date('2026-09-03T12:00:30.000Z'),
        }),
        ledgerRow({ id: 'row-released', status: 'RELEASED', releaseReason: 'GATED' }),
        ledgerRow({ id: 'row-expired-already', status: 'EXPIRED' }),
      ],
    })

    await expect(expireBudgetLeases(tx, { now, limit: 10 })).resolves.toEqual([])
    expect(rows.map((row) => row.status)).toEqual(['SETTLED', 'RELEASED', 'EXPIRED'])
    expect(rows[0]?.finalizedAt?.toISOString()).toBe('2026-09-03T12:00:30.000Z')
  })

  it('按 leaseExpiresAt 升序挑，limit 截断，剩下的下一轮再回收', async () => {
    const now = new Date('2026-09-03T12:10:00.000Z')
    const { tx, rows } = createFakeTx({
      now,
      rows: [
        ledgerRow({ id: 'row-third', leaseExpiresAt: new Date('2026-09-03T12:03:00.000Z') }),
        ledgerRow({ id: 'row-first', leaseExpiresAt: new Date('2026-09-03T12:01:00.000Z') }),
        ledgerRow({ id: 'row-second', leaseExpiresAt: new Date('2026-09-03T12:02:00.000Z') }),
      ],
    })

    const firstBatch = await expireBudgetLeases(tx, { now, limit: 2 })
    expect(firstBatch.map((row) => row.ledgerId)).toEqual(['row-first', 'row-second'])
    expect(rows.find((row) => row.id === 'row-third')?.status).toBe('RESERVED')

    const secondBatch = await expireBudgetLeases(tx, { now, limit: 2 })
    expect(secondBatch.map((row) => row.ledgerId)).toEqual(['row-third'])
    expect(rows.every((row) => row.status === 'EXPIRED')).toBe(true)
  })

  it('回收不带 tenantId：一批里可以跨租户', async () => {
    // 这就是索引 (status, leaseExpiresAt) 必须以 status 开头的原因——回收任务没有租户谓词可用。
    const otherTenant = '018f0000-0000-7000-8000-000000000002'
    const now = new Date('2026-09-03T12:10:00.000Z')
    const { tx } = createFakeTx({
      now,
      rows: [
        ledgerRow({ id: 'row-a', leaseExpiresAt: new Date('2026-09-03T12:01:00.000Z') }),
        ledgerRow({
          id: 'row-b',
          tenantId: otherTenant,
          idempotencyKey: 'key-b',
          leaseExpiresAt: new Date('2026-09-03T12:02:00.000Z'),
        }),
      ],
    })

    const reclaimed = await expireBudgetLeases(tx, { now, limit: 10 })

    expect(reclaimed.map((row) => row.tenantId)).toEqual([tenantId, otherTenant])
  })

  it('没有可回收的行时返回空数组', async () => {
    const now = new Date('2026-09-03T12:00:30.000Z')
    const { tx } = createFakeTx({ now, rows: [ledgerRow()] })

    await expect(expireBudgetLeases(tx, { now, limit: 10 })).resolves.toEqual([])
  })

  it('批量上限必须是正整数', async () => {
    const { tx, calls } = createFakeTx({ rows: [ledgerRow()] })

    for (const limit of [0, -1, 1.5]) {
      await expect(
        expireBudgetLeases(tx, { now: new Date('2026-09-03T12:10:00.000Z'), limit }),
      ).rejects.toThrow('回收批量上限必须是正整数')
    }
    // 无界回收会把一次任务变成全表更新，所以在发语句之前就拦下。
    expect(calls).not.toContain('expire')
  })
})
