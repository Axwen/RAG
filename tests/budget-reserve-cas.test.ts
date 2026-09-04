import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { Prisma, releaseBudget, reserveBudget, settleBudget } from '@rag/database'
import type { BudgetLimits, Pool, ReserveBudgetResult } from '@rag/database'
import { asGranted, asLayerRejection, asPoolRejection } from './helpers/budget-result'
import {
  IntegrationDb,
  answerRunId,
  cny,
  idempotencyKey,
  integrationLimits,
} from './helpers/integration-db'

/**
 * 预扣的四层 CAS，跑在真 PostgreSQL 上。
 *
 * 这一层只验单元层证不出来的东西：
 * - **窗口求和的口径。** `committedAmounts` 是一段裸 SQL，`CASE WHEN status = 'SETTLED' THEN
 *   "actualAmount" ELSE "reservedAmount" END` 与 `status IN ('RESERVED','SETTLED')` 这两条口径
 *   写在 SQL 字符串里，假事务替换掉的正是这段 SQL，所以单元层换个实现也一样绿。
 * - **并发。** 「两个请求同时预扣到日限边界只有一个成功」（T12 验证）靠租户级 advisory lock
 *   成立，假事务里没有锁。
 * - **幂等键撞唯一约束。** 单元层的假事务不带唯一索引，重放路径只是一次 map 查找。
 */

const db = new IntegrationDb()
/** 并发用例里第二个事务要在 advisory lock 上真的排队，5s 的默认值不够。 */
const TX = { timeout: 20_000, maxWait: 10_000 } as const

afterEach(async () => {
  // 同一文件的下一个用例换新租户，但账本行留着会让「本租户已用额度」的断言变得依赖执行顺序。
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
        owner: { answerRunId: answerRunId() },
        limits,
      }),
    TX,
  )
}

/** 日限压到 ¥1：一位小数就能撞到边界，不必造十六块钱的假账。 */
const dailyOne: BudgetLimits = { ...integrationLimits, dailyCny: 1 }

describe('窗口求和的口径（真库的 committedAmounts）', () => {
  it('SETTLED 行按 actualAmount 计入：结算低于预扣，差额当场还回额度', async () => {
    const tenantId = await db.createTenant('settled-actual')

    const first = asGranted(await reserve(tenantId, idempotencyKey('a'), '0.8', dailyOne))
    const settled = await db.prisma.$transaction(
      (tx) =>
        settleBudget(tx, {
          ledgerId: first.ledgerId,
          tenantId,
          actualAmount: cny('0.3'),
          costSource: 'PROVIDER',
        }),
      TX,
    )
    if (!settled.ok) {
      throw new Error(`期望结算成功，实际拿到：${JSON.stringify(settled)}`)
    }
    expect(settled.delta.toFixed(6)).toBe('-0.500000')

    // 按 reservedAmount 求和的话这里是 0.8 + 0.6 = 1.4 > 1，会被拒。能过说明 SQL 里取的是
    // actualAmount——「多占的额度随本次结算自动还回，不需要写冲账行」这句话的落点就在这。
    asGranted(await reserve(tenantId, idempotencyKey('b'), '0.6', dailyOne))

    // 再钉一次求和值本身：0.3 + 0.6 = 0.9，还剩 0.1。
    const third = asLayerRejection(await reserve(tenantId, idempotencyKey('c'), '0.2', dailyOne))
    expect(third.layer).toBe('DAILY')
    expect(third.remaining.toFixed(6)).toBe('0.100000')
  })

  it('RELEASED 行不占额度：释放过的预扣不算已用', async () => {
    const tenantId = await db.createTenant('released-excluded')

    const first = asGranted(await reserve(tenantId, idempotencyKey('a'), '0.8', dailyOne))
    const released = await db.prisma.$transaction(
      (tx) => releaseBudget(tx, { ledgerId: first.ledgerId, tenantId, reason: 'GATED' }),
      TX,
    )
    expect(released.ok).toBe(true)

    asGranted(await reserve(tenantId, idempotencyKey('b'), '0.8', dailyOne))

    const rows = await db.prisma.modelBudgetLedger.findMany({
      where: { tenantId },
      select: { status: true },
      orderBy: { createdAt: 'asc' },
    })
    expect(rows.map((row) => row.status)).toEqual(['RELEASED', 'RESERVED'])
  })

  it('日限跨池求和：交互池花掉的钱算进当日总额，评测池跟着被拒', async () => {
    const tenantId = await db.createTenant('daily-cross-pool')

    asGranted(await reserve(tenantId, idempotencyKey('a'), '0.6', dailyOne, 'INTERACTIVE'))
    const rejected = asLayerRejection(
      await reserve(tenantId, idempotencyKey('b'), '0.6', dailyOne, 'EVALUATION'),
    )
    expect(rejected.layer).toBe('DAILY')
    expect(rejected.remaining.toFixed(6)).toBe('0.400000')
  })

  it('池边界只看本池：评测池满了不影响交互池，且原因码与额度层不同', async () => {
    const tenantId = await db.createTenant('pool-boundary')
    // 池上限比日限更紧，才能让请求先撞在池边界上。三池之和仍等于月度上限（ADR-0029）。
    const tightEvaluation: BudgetLimits = {
      ...integrationLimits,
      pools: { interactive: 9, evaluation: 0.5, reserve: 0.5 },
    }

    asGranted(await reserve(tenantId, idempotencyKey('a'), '0.4', tightEvaluation, 'EVALUATION'))
    const rejected = asPoolRejection(
      await reserve(tenantId, idempotencyKey('b'), '0.4', tightEvaluation, 'EVALUATION'),
    )
    expect(rejected.pool).toBe('EVALUATION')
    expect(rejected.remaining.toFixed(6)).toBe('0.100000')

    // 同一个租户、同样的金额，换到交互池就通过：池是隔离边界（T10 在费用维度上的同一条），
    // 不是「租户没钱了」。
    asGranted(await reserve(tenantId, idempotencyKey('c'), '0.4', tightEvaluation, 'INTERACTIVE'))
  })
})

describe('时间列取自库时钟', () => {
  it('createdAt 与 leaseExpiresAt 落在事务开始时刻上，不落在应用时钟上', async () => {
    const tenantId = await db.createTenant('tx-clock')

    // 在同一个事务里问一次库时钟，再比对写进去的两列。Prisma 会在**客户端**为
    // `@default(now())` 生成值，列的 DEFAULT 只对省略该列的原始 SQL 生效——那条路径下这两个
    // 断言会差几毫秒。差几毫秒本身无害，跨零点的那一次调用不是：CAS 按事务时钟切日窗口，
    // 行却按客户端时钟落进第二天，日限就被绕过了（committedAmounts 求和的正是 createdAt）。
    const written = await db.prisma.$transaction(async (tx) => {
      const clock = await tx.$queryRaw<Array<{ now: Date }>>(
        Prisma.sql`SELECT CURRENT_TIMESTAMP AS now`,
      )
      const txNow = clock[0]?.now
      if (txNow === undefined) {
        throw new Error('取不到事务时钟：这个用例没有意义了，不能让它静默通过')
      }
      const granted = asGranted(
        await reserveBudget(tx, {
          tenantId,
          idempotencyKey: idempotencyKey('tx-clock'),
          pool: 'INTERACTIVE',
          estimatedAmount: cny('0.1'),
          exchangeRate: cny('1'),
          owner: { answerRunId: answerRunId() },
          limits: integrationLimits,
        }),
      )
      return { txNow, ledgerId: granted.ledgerId }
    }, TX)

    const row = await db.prisma.modelBudgetLedger.findUniqueOrThrow({
      where: { id: written.ledgerId },
      select: { createdAt: true, leaseExpiresAt: true },
    })
    expect(row.createdAt.toISOString()).toBe(written.txNow.toISOString())
    // 同一个时刻推 lease：回收窗口与 CAS 窗口因此对齐。
    expect(row.leaseExpiresAt.getTime()).toBe(
      written.txNow.getTime() + integrationLimits.lease.defaultSeconds * 1000,
    )
  })
})

describe('并发预扣（租户级 advisory lock）', () => {
  it('两个请求同时预扣到日限边界，只有一个成功', async () => {
    const tenantId = await db.createTenant('race-daily')

    // 两笔各 0.8、日限 1：数学上只能过一笔。没有 advisory lock 时两笔都会读到「已用 0」，
    // 于是双双通过、日限被突破——这正是 T12 验证要钉的那条。
    const results = await Promise.all([
      reserve(tenantId, idempotencyKey('race-a'), '0.8', dailyOne),
      reserve(tenantId, idempotencyKey('race-b'), '0.8', dailyOne),
    ])

    // 谁赢由调度决定，所以按多重集断言：一个通过、一个撞在日限上还剩 0.2。
    const granted = results.filter((result) => result.ok)
    expect(granted).toHaveLength(1)
    const rejected = results.filter((result) => !result.ok)
    expect(rejected).toHaveLength(1)
    const layer = asLayerRejection(rejected[0])
    expect(layer.layer).toBe('DAILY')
    expect(layer.remaining.toFixed(6)).toBe('0.200000')

    // 库里只留一行：被拒的那笔连行都不写（拒绝走审计，不走账本）。
    expect(await db.prisma.modelBudgetLedger.count({ where: { tenantId } })).toBe(1)
  })

  it('同一幂等键并发到达：两边拿到同一行，第二次标记为重放', async () => {
    const tenantId = await db.createTenant('race-replay')
    const key = idempotencyKey('same')

    const results = await Promise.all([
      reserve(tenantId, key, '0.8', dailyOne),
      reserve(tenantId, key, '0.8', dailyOne),
    ])
    const granted = results.map((result) => asGranted(result))

    expect(granted[0]?.ledgerId).toBe(granted[1]?.ledgerId)
    // 先到的那次是真扣款，后到的那次读到已提交的行——顺序不定，所以按多重集比。
    expect([granted[0]?.replayed, granted[1]?.replayed].sort()).toEqual([false, true])
    expect(await db.prisma.modelBudgetLedger.count({ where: { tenantId } })).toBe(1)
  })

  it('租户 A 的预扣不影响租户 B：两个租户并发都成功', async () => {
    const [tenantA, tenantB] = await Promise.all([
      db.createTenant('isolation-a'),
      db.createTenant('isolation-b'),
    ])
    if (tenantA === undefined || tenantB === undefined) {
      throw new Error('租户创建失败')
    }

    // 锁的粒度是租户，两个租户各自占满日限；粒度错成全局时这里会串行但仍然绿，
    // 所以真正的判据是两边都通过、各自只有一行。
    const results = await Promise.all([
      reserve(tenantA, idempotencyKey('a'), '0.8', dailyOne),
      reserve(tenantB, idempotencyKey('b'), '0.8', dailyOne),
    ])
    for (const result of results) {
      expect(asGranted(result).reservedAmount.toFixed(6)).toBe('0.800000')
    }
    expect(await db.prisma.modelBudgetLedger.count({ where: { tenantId: tenantA } })).toBe(1)
    expect(await db.prisma.modelBudgetLedger.count({ where: { tenantId: tenantB } })).toBe(1)
  })
})

describe('幂等键（唯一约束 (tenantId, idempotencyKey)）', () => {
  it('重放不重复扣款：额度只被占用一次', async () => {
    const tenantId = await db.createTenant('replay-once')
    const key = idempotencyKey('retry')

    const first = asGranted(await reserve(tenantId, key, '0.8', dailyOne))
    expect(first.replayed).toBe(false)

    const replay = asGranted(await reserve(tenantId, key, '0.8', dailyOne))
    expect(replay.replayed).toBe(true)
    expect(replay.ledgerId).toBe(first.ledgerId)
    expect(await db.prisma.modelBudgetLedger.count({ where: { tenantId } })).toBe(1)

    // 已用额度是 0.8 而不是 1.6：换个键的 0.2 刚好把日限用光。
    asGranted(await reserve(tenantId, idempotencyKey('next'), '0.2', dailyOne))
    const exhausted = asLayerRejection(
      await reserve(tenantId, idempotencyKey('over'), '0.05', dailyOne),
    )
    expect(exhausted.layer).toBe('DAILY')
    // 剩余被夹到 0，不是 -0.05：算出来的负数不该漏进给调用方的字段（remainingOf 的钳位）。
    expect(exhausted.remaining.toFixed(6)).toBe('0.000000')
  })

  it('幂等键按租户隔离：同一个键在两个租户各写一行', async () => {
    const [tenantA, tenantB] = await Promise.all([
      db.createTenant('key-scope-a'),
      db.createTenant('key-scope-b'),
    ])
    if (tenantA === undefined || tenantB === undefined) {
      throw new Error('租户创建失败')
    }
    // 上游的幂等键通常是「请求 ID」，不带租户前缀。唯一约束是 (tenantId, idempotencyKey) 而不是
    // 单列，租户 B 的调用才不会被租户 A 的历史吞成重放。
    const shared = idempotencyKey('shared')

    const a = asGranted(await reserve(tenantA, shared, '0.5', dailyOne))
    const b = asGranted(await reserve(tenantB, shared, '0.5', dailyOne))
    expect(a.ledgerId).not.toBe(b.ledgerId)
    expect(b.replayed).toBe(false)
  })
})
