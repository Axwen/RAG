import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { Prisma, reserveBudget, settleBudget, writeAuditEvent } from '@rag/database'
import type { AuditEventInput, BudgetLimits, ReserveBudgetResult } from '@rag/database'
import { asGranted } from './helpers/budget-result'
import {
  IntegrationDb,
  answerRunId,
  cny,
  idempotencyKey,
  integrationLimits,
} from './helpers/integration-db'

/**
 * 「审计写失败则业务失败」与库层不变量，跑在真 PostgreSQL 上。
 *
 * ADR-0035 那条「审计写失败则业务失败」不是靠 `writeAuditEvent` 抛异常就成立的——抛异常之后
 * **业务写入必须跟着消失**，而那一步是 PostgreSQL 的事务回滚干的。假事务里没有回滚，
 * 单元层最多能证「它抛了」。
 *
 * 后半段验的是库层不变量：CHECK 与状态机触发器。它们的存在理由正是「绕过 TS 的写入路径」
 * （裸 SQL、psql、以后某个用别的语言写的服务），所以这里也用裸 SQL 去撞——用 Prisma 的
 * 类型化 API 撞不到，那等于只测了 TypeScript。
 */

const db = new IntegrationDb()
const TX = { timeout: 20_000, maxWait: 10_000 } as const
const limits: BudgetLimits = integrationLimits

afterEach(async () => {
  await db.clearLedger()
})
afterAll(async () => {
  await db.cleanup()
})

function reserveIn(
  tx: Parameters<typeof reserveBudget>[0],
  tenantId: string,
  key: string,
): Promise<ReserveBudgetResult> {
  return reserveBudget(tx, {
    tenantId,
    idempotencyKey: key,
    pool: 'INTERACTIVE',
    estimatedAmount: cny('0.1'),
    exchangeRate: cny('1'),
    owner: { answerRunId: answerRunId() },
    limits,
  })
}

describe('审计写失败回滚业务事务', () => {
  it('未注册的 reasonCode 让整个事务回滚：账本行不留下', async () => {
    const tenantId = await db.createTenant('audit-rollback-js')

    // 预扣先成功，再让审计失败——顺序很重要：如果审计的校验发生在业务写入之前，
    // 这个用例就退化成「校验拦住了调用」，证不到回滚。
    await expect(
      db.prisma.$transaction(async (tx) => {
        const reserved = await reserveIn(tx, tenantId, idempotencyKey('rollback'))
        expect(reserved.ok).toBe(true)
        // 库里已经有这一行了（同一事务内可见），但事务还没提交。
        expect(await tx.modelBudgetLedger.count({ where: { tenantId } })).toBe(1)
        await writeAuditEvent(tx, {
          tenantId,
          // 绕过编译期的 `ReasonCode`：`writeAuditEvent` 的注册表检查兜的正是这种调用方。
          reasonCode: 'budget.not_a_registered_code' as AuditEventInput['reasonCode'],
          outcome: 'DENIED',
        })
      }, TX),
    ).rejects.toThrow(/审计 reasonCode 未注册/)

    // 这一行才是 ADR-0035 那条不变量：审计没写成，钱就没扣。
    expect(await db.prisma.modelBudgetLedger.count({ where: { tenantId } })).toBe(0)
  })

  it('库层拒绝审计行时同样回滚：CHECK 抛的错也会带走业务写入', async () => {
    const tenantId = await db.createTenant('audit-rollback-db')

    // 这次不走 `writeAuditEvent`，直接裸 SQL 插一条驼峰命名的 reasonCode：
    // 失败来自 PostgreSQL 的 CHECK 而不是 JS 校验，回滚的责任方就只剩事务本身。
    await expect(
      db.prisma.$transaction(async (tx) => {
        await reserveIn(tx, tenantId, idempotencyKey('rollback-db'))
        await tx.$executeRaw(Prisma.sql`
          INSERT INTO "domain_audit_event"
            ("id", "tenantId", "category", "reasonCode", "outcome", "actorType")
          VALUES
            (gen_random_uuid(), ${tenantId}::uuid, 'BUDGET', 'budget.reserveRejected',
             'DENIED', 'SYSTEM')
        `)
      }, TX),
    ).rejects.toThrow(/domain_audit_event_reason_code_namespaced/)

    expect(await db.prisma.modelBudgetLedger.count({ where: { tenantId } })).toBe(0)
  })
})

describe('审计行的派生列与不可变性', () => {
  it('同一事务里的多条审计共享 occurredAt，category 由 reasonCode 派生', async () => {
    const tenantId = await db.createTenant('audit-derived')

    const written = await db.prisma.$transaction(async (tx) => {
      const first = await writeAuditEvent(tx, {
        tenantId,
        reasonCode: 'budget.lease_expired',
        outcome: 'RECLAIMED',
        actor: { system: 'LEASE_REAPER' },
        subject: { type: 'model_budget_ledger', id: answerRunId() },
      })
      const second = await writeAuditEvent(tx, {
        tenantId,
        reasonCode: 'budget.settlement_delta',
        outcome: 'ALLOWED',
      })
      return [first.auditEventId, second.auditEventId]
    }, TX)

    const rows = await db.prisma.domainAuditEvent.findMany({
      where: { id: { in: written } },
      select: {
        id: true,
        occurredAt: true,
        category: true,
        reasonCode: true,
        actorType: true,
        actorId: true,
      },
      orderBy: { reasonCode: 'asc' },
    })
    expect(rows).toHaveLength(2)
    // `occurredAt` 走列的 DEFAULT CURRENT_TIMESTAMP = 事务开始时间，所以同一事务里的
    // 两条审计时间完全相同。调用方自己 `new Date()` 的话这里会差几毫秒，审计与业务行的
    // 时间也就对不上了。
    expect(rows[0]?.occurredAt.getTime()).toBe(rows[1]?.occurredAt.getTime())
    // category 不是调用方传的，是注册表按码派生的：写不出 category=AUTHZ + reasonCode=budget.* 的行。
    expect(rows.map((row) => row.category)).toEqual(['BUDGET', 'BUDGET'])
    // `{ system }` 的 actorId 记动作名（不是 uuid），省略 actor 时留空。
    expect(rows.find((row) => row.reasonCode === 'budget.lease_expired')?.actorId).toBe(
      'LEASE_REAPER',
    )
    const settlement = rows.find((row) => row.reasonCode === 'budget.settlement_delta')
    expect(settlement?.actorType).toBe('SYSTEM')
    expect(settlement?.actorId).toBeNull()
  })

  it('审计行 append-only：UPDATE 与 DELETE 都被库拒绝', async () => {
    const tenantId = await db.createTenant('audit-append-only')
    const { auditEventId } = await db.prisma.$transaction(
      (tx) =>
        writeAuditEvent(tx, {
          tenantId,
          reasonCode: 'budget.reserve_rejected',
          outcome: 'DENIED',
        }),
      TX,
    )

    // ADR-0040 决策 5。触发器是 BEFORE UPDATE OR DELETE FOR EACH ROW，所以 Prisma 能走的
    // 每一条改写路径都会撞上它——包括测试自己的清理路径（`IntegrationDb.cleanup` 因此不删审计行）。
    await expect(
      db.prisma.domainAuditEvent.update({
        where: { id: auditEventId },
        data: { outcome: 'ALLOWED' },
      }),
    ).rejects.toThrow(/domain audit event is append-only/)
    await expect(
      db.prisma.domainAuditEvent.deleteMany({ where: { id: auditEventId } }),
    ).rejects.toThrow(/domain audit event is append-only/)

    const row = await db.prisma.domainAuditEvent.findUniqueOrThrow({
      where: { id: auditEventId },
      select: { outcome: true },
    })
    expect(row.outcome).toBe('DENIED')
  })
})

/**
 * 批量抹除只能靠语句级触发器挡。TRUNCATE 不触发任何行级触发器，所以
 * `domain_audit_event_append_only`（`BEFORE UPDATE OR DELETE FOR EACH ROW`）对它完全无效：
 * 上一条迁移把这条路留着，于是「审计不可变」在一条语句面前不成立。账本更糟——余额的事实源
 * 只有它（ADR-0029），清空等于把所有花销归零，而 Redis 里还缓着旧余额。
 *
 * 撞它必须用裸 SQL：Prisma 没有 truncate API，而防线要挡的正是没有类型化 API 的那些路径
 * （psql、清库脚本、以后某个用别的语言写的服务）。
 */
describe('事实表不得被批量抹掉（TRUNCATE 防线）', () => {
  /**
   * 包一层会回滚的事务。防线万一不在了，TRUNCATE 会**真的成功**，而这两张表在本机开发库里
   * 攒着几十轮跑下来的事实。哨兵异常让 Prisma 回滚，于是「防线没了」的结局是测试红，
   * 不是先把表清空再报红。
   */
  async function expectTruncateRejected(sql: Prisma.Sql, label: string): Promise<void> {
    await expect(
      db.prisma.$transaction(async (tx) => {
        await tx.$executeRaw(sql)
        throw new Error(`${label} 没有被拒绝：批量抹除防线不在了（本次已回滚）`)
      }, TX),
    ).rejects.toThrow(/must not be erasable in bulk/)
  }

  it('审计表与账本都挡住直接 TRUNCATE', async () => {
    const tenantId = await db.createTenant('truncate-guard')
    await db.prisma.$transaction(
      (tx) =>
        writeAuditEvent(tx, {
          tenantId,
          reasonCode: 'budget.reserve_rejected',
          outcome: 'DENIED',
        }),
      TX,
    )
    const auditRows = await db.prisma.domainAuditEvent.count()

    await expectTruncateRejected(
      Prisma.sql`TRUNCATE "domain_audit_event"`,
      'TRUNCATE domain_audit_event',
    )
    await expectTruncateRejected(
      Prisma.sql`TRUNCATE "model_budget_ledger"`,
      'TRUNCATE model_budget_ledger',
    )

    // 断言行数而不是只断言抛异常：`BEFORE` 触发器抛在前，一行都不该少。
    expect(await db.prisma.domainAuditEvent.count()).toBe(auditRows)
  })

  it('从 tenants 级联下来的 TRUNCATE 同样挡住', async () => {
    // `TRUNCATE ... CASCADE` 会在**每张被级联的表**上触发语句级触发器，所以「清一下租户表」
    // 这条最容易手抖的路径也走不通。这正是行级 append-only 触发器完全看不见的那条路径：
    // 它一行 DELETE 都没发生，两张事实表却会被一起清空。
    await expectTruncateRejected(Prisma.sql`TRUNCATE "tenants" CASCADE`, 'TRUNCATE tenants CASCADE')
  })
})

/**
 * 裸 SQL 插一行账本。库层 CHECK 存在的理由就是「绕过事务入口的写入路径」，所以撞它们必须
 * 绕过 Prisma 的类型化 API——用 `create()` 撞不到，那只证明了 TypeScript 在工作。
 *
 * `id` 用 `gen_random_uuid()`：`@default(uuid(7))` 是客户端默认值，库里这一列没有 DEFAULT。
 */
interface RawLedgerRow {
  tenantId: string
  idempotencyKey: string
  status: 'RESERVED' | 'SETTLED' | 'RELEASED' | 'EXPIRED'
  reservedAmount: string
  actualAmount: string | null
  costSource: 'PROVIDER' | 'ESTIMATED' | null
  releaseReason: 'GATED' | 'CANCELLED_BEFORE_DISPATCH' | null
  exchangeRate: string
  answerRunId: string | null
  jobId: string | null
  finalizedAt: Date | null
}

function rawRow(tenantId: string, overrides: Partial<RawLedgerRow> = {}): RawLedgerRow {
  return {
    tenantId,
    idempotencyKey: idempotencyKey('raw'),
    status: 'RESERVED',
    reservedAmount: '0.1',
    actualAmount: null,
    costSource: null,
    releaseReason: null,
    exchangeRate: '1',
    answerRunId: answerRunId(),
    jobId: null,
    finalizedAt: null,
    ...overrides,
  }
}

function insertLedgerRaw(row: RawLedgerRow): Promise<number> {
  return db.prisma.$executeRaw(Prisma.sql`
    INSERT INTO "model_budget_ledger"
      ("id", "tenantId", "idempotencyKey", "pool", "status", "reservedAmount", "actualAmount",
       "costSource", "releaseReason", "exchangeRate", "leaseExpiresAt", "answerRunId", "jobId",
       "finalizedAt")
    VALUES
      (gen_random_uuid(), ${row.tenantId}::uuid, ${row.idempotencyKey}, 'INTERACTIVE',
       ${row.status}::"BudgetLedgerStatus", ${row.reservedAmount}::numeric,
       ${row.actualAmount}::numeric, ${row.costSource}::"BudgetCostSource",
       ${row.releaseReason}::"BudgetReleaseReason", ${row.exchangeRate}::numeric,
       CURRENT_TIMESTAMP + INTERVAL '60 seconds', ${row.answerRunId}::uuid, ${row.jobId}::uuid,
       ${row.finalizedAt})
  `)
}

describe('状态机触发器（库层的另一半）', () => {
  it('终态行没有合法后继：改一个已结算的行直接抛', async () => {
    const tenantId = await db.createTenant('trigger-final')
    const row = asGranted(
      await db.prisma.$transaction((tx) => reserveIn(tx, tenantId, idempotencyKey('final')), TX),
    )
    await db.prisma.$transaction(
      (tx) =>
        settleBudget(tx, {
          ledgerId: row.ledgerId,
          tenantId,
          actualAmount: cny('0.05'),
          costSource: 'PROVIDER',
        }),
      TX,
    )

    // 事务入口自己靠 `updateMany({ where: { status: 'RESERVED' } })` 落空来避开这条触发器，
    // 所以入口路径永远看不到它。裸 SQL 看得到——「恰好一次终态转移」在库里是真的。
    await expect(
      db.prisma.$executeRaw(
        Prisma.sql`UPDATE "model_budget_ledger" SET "actualAmount" = 9 WHERE "id" = ${row.ledgerId}::uuid`,
      ),
    ).rejects.toThrow(/budget ledger row is final: SETTLED/)

    const stored = await db.prisma.modelBudgetLedger.findUniqueOrThrow({
      where: { id: row.ledgerId },
      select: { actualAmount: true },
    })
    expect(stored.actualAmount?.toFixed(6)).toBe('0.050000')
  })

  it('预扣事实不可改写：改 RESERVED 行的金额等于改账', async () => {
    const tenantId = await db.createTenant('trigger-facts')
    const row = asGranted(
      await db.prisma.$transaction((tx) => reserveIn(tx, tenantId, idempotencyKey('facts')), TX),
    )

    // 行还是 RESERVED（第一条分支不触发），拦住它的是第二条：金额、汇率、租户、幂等键、池、
    // 创建时间在预扣之后就是事实。少了这条，一次 UPDATE 就能把日限内的账改成任意数字。
    await expect(
      db.prisma.$executeRaw(
        Prisma.sql`UPDATE "model_budget_ledger" SET "reservedAmount" = 99 WHERE "id" = ${row.ledgerId}::uuid`,
      ),
    ).rejects.toThrow(/budget ledger reservation facts are immutable/)

    // 续租改 leaseExpiresAt 与 renewCount 是允许的：那两列不在事实清单里。
    await db.prisma.$executeRaw(
      Prisma.sql`UPDATE "model_budget_ledger" SET "renewCount" = "renewCount" + 1 WHERE "id" = ${row.ledgerId}::uuid`,
    )
    const stored = await db.prisma.modelBudgetLedger.findUniqueOrThrow({
      where: { id: row.ledgerId },
      select: { reservedAmount: true, renewCount: true },
    })
    expect(stored.reservedAmount.toFixed(6)).toBe('0.100000')
    expect(stored.renewCount).toBe(1)
  })
})

describe('账本行的库层 CHECK', () => {
  it('归属恰好一个：两列都空或都填都进不去', async () => {
    const tenantId = await db.createTenant('check-owner')

    await expect(
      insertLedgerRaw(rawRow(tenantId, { answerRunId: null, jobId: null })),
    ).rejects.toThrow(/model_budget_ledger_owner_exactly_one/)
    await expect(
      insertLedgerRaw(rawRow(tenantId, { answerRunId: answerRunId(), jobId: answerRunId() })),
    ).rejects.toThrow(/model_budget_ledger_owner_exactly_one/)

    // 恰好一个则通过——两种归属各一次，证明约束不是「必须是 answerRunId」。
    expect(
      await insertLedgerRaw(rawRow(tenantId, { answerRunId: answerRunId(), jobId: null })),
    ).toBe(1)
    expect(
      await insertLedgerRaw(rawRow(tenantId, { answerRunId: null, jobId: answerRunId() })),
    ).toBe(1)
  })

  it('状态字段完备性：SETTLED 缺 actualAmount 进不去', async () => {
    const tenantId = await db.createTenant('check-status-fields')

    await expect(
      insertLedgerRaw(
        rawRow(tenantId, {
          status: 'SETTLED',
          finalizedAt: new Date(),
          costSource: 'PROVIDER',
          actualAmount: null,
        }),
      ),
    ).rejects.toThrow(/model_budget_ledger_status_fields_consistent/)

    // 同一状态补齐 actualAmount 就能进：约束管的是「这个状态该有哪些字段」，不是禁止 SETTLED。
    expect(
      await insertLedgerRaw(
        rawRow(tenantId, {
          status: 'SETTLED',
          finalizedAt: new Date(),
          costSource: 'PROVIDER',
          actualAmount: '0.05',
        }),
      ),
    ).toBe(1)
  })

  it('取值域：负金额与零汇率进不去', async () => {
    const tenantId = await db.createTenant('check-domains')

    await expect(insertLedgerRaw(rawRow(tenantId, { reservedAmount: '-0.1' }))).rejects.toThrow(
      /model_budget_ledger_amounts_nonnegative/,
    )
    // 汇率为 0 会把所有折算金额抹成 0，等于把门禁关掉——这是取值域约束里最不能少的一条。
    await expect(insertLedgerRaw(rawRow(tenantId, { exchangeRate: '0' }))).rejects.toThrow(
      /model_budget_ledger_exchange_rate_positive/,
    )
  })

  it('幂等键唯一：同租户同键的第二行被唯一索引挡住', async () => {
    const tenantId = await db.createTenant('check-unique-key')
    const key = idempotencyKey('duplicate')

    expect(await insertLedgerRaw(rawRow(tenantId, { idempotencyKey: key }))).toBe(1)
    // 这条唯一索引是「幂等键重放不重复扣款」的最后一道：事务入口先查后插之间即使真的出现
    // 竞态（advisory lock 被绕过或换实现），库也不会留下两行。
    await expect(insertLedgerRaw(rawRow(tenantId, { idempotencyKey: key }))).rejects.toThrow(
      /model_budget_ledger_tenantId_idempotencyKey_key/,
    )
  })
})
