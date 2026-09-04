import { Prisma } from '../src/generated/prisma/client'
import type { Tx } from '../src/tx'
import { dayWindow, monthWindow } from '../src/budget/windows'

/**
 * 单元层的假事务句柄。
 *
 * 为什么需要它：预算入口的**判定逻辑**（四层 CAS 的层序与比较、结算差额、非法转移、
 * 续租上限）与**SQL 的保真度**是两件事。判定逻辑值得逐条钉住，而真实数据库只在集成层
 * 才有（`tests/` 里那一套跑在 Compose 起的 PostgreSQL 上）。没有这一层，四层 CAS 的层序
 * 就只能靠读代码确认。
 *
 * 它**不**替代集成测试，而且这个边界要说清楚：
 * - 窗口求和在这里是用 JS 按同一条口径（只算 RESERVED 与 SETTLED；SETTLED 取
 *   `actualAmount`）重算的，所以它证明的是「入口对求和结果的处理」，不是那段 SQL 本身对。
 * - advisory lock、`FOR UPDATE SKIP LOCKED`、唯一约束、CHECK 与状态机触发器在这里都不存在。
 *   并发竞态、幂等重放撞唯一键、lease 回收与「审计写失败回滚业务事务」只能在集成层证明。
 *
 * 有一处是**刻意**照抄真实行为的不便：`create` 在调用方省略 `createdAt`/`occurredAt` 时填的是
 * `clientClock` 而不是事务时钟 `now`（见下），因为 Prisma Client 就是在客户端生成
 * `@default(now())` 的。两个时钟故意差 5 秒，于是「入口是否显式传了库时钟」在这一层就能断言，
 * 不必等集成层去抓跨零点绕过日限的那一次调用。
 */

export interface FakeLedgerRow {
  id: string
  tenantId: string
  idempotencyKey: string
  pool: 'INTERACTIVE' | 'EVALUATION' | 'RESERVE'
  status: 'RESERVED' | 'SETTLED' | 'RELEASED' | 'EXPIRED'
  reservedAmount: Prisma.Decimal
  actualAmount: Prisma.Decimal | null
  costSource: 'PROVIDER' | 'ESTIMATED' | null
  releaseReason: 'GATED' | 'CANCELLED_BEFORE_DISPATCH' | null
  exchangeRate: Prisma.Decimal
  leaseExpiresAt: Date
  renewCount: number
  answerRunId: string | null
  jobId: string | null
  createdAt: Date
  finalizedAt: Date | null
}

export interface FakeAuditRow {
  id: string
  tenantId: string
  occurredAt: Date
  category: string
  reasonCode: string
  outcome: string
  actorType: string
  actorId: string | null
  subjectType: string | null
  subjectId: string | null
  detail?: unknown
  traceId: string | null
}

export interface FakeTx {
  tx: Tx
  /** 账本行的当前状态，测试直接断言。 */
  rows: FakeLedgerRow[]
  /** 写进去的审计行。 */
  audits: FakeAuditRow[]
  /** `$queryRaw` 的调用序，用来断言 advisory lock 确实在幂等查询之前。 */
  calls: string[]
}

/**
 * 假账本行的默认租户。
 *
 * 与入口的 `tenantId` 谓词必须是同一个值，否则「造一行占用额度」的测试会因为租户不匹配而
 * 静默变成「库里没有用量」——那样的测试会全绿，但什么都没验到。
 */
export const fakeTenantId = '018f0000-0000-7000-8000-000000000001'

/** 只填测试关心的字段，其余给默认值。 */
export function ledgerRow(overrides: Partial<FakeLedgerRow> = {}): FakeLedgerRow {
  return {
    id: 'row-1',
    tenantId: fakeTenantId,
    idempotencyKey: 'key-1',
    pool: 'INTERACTIVE',
    status: 'RESERVED',
    reservedAmount: new Prisma.Decimal('1.000000'),
    actualAmount: null,
    costSource: null,
    releaseReason: null,
    exchangeRate: new Prisma.Decimal('7.200000'),
    leaseExpiresAt: new Date('2026-09-03T12:01:00.000Z'),
    renewCount: 0,
    answerRunId: '11111111-1111-7111-8111-111111111111',
    jobId: null,
    createdAt: new Date('2026-09-03T12:00:00.000Z'),
    finalizedAt: null,
    ...overrides,
  }
}

const poolNames = new Set(['INTERACTIVE', 'EVALUATION', 'RESERVE'])

function amountOf(row: FakeLedgerRow): Prisma.Decimal {
  // 与 committedAmounts 的 CASE 同一条口径：SETTLED 记实际值，其余记预扣值。
  return row.status === 'SETTLED' ? (row.actualAmount ?? new Prisma.Decimal(0)) : row.reservedAmount
}

function sum(rows: FakeLedgerRow[]): string {
  // 真实 SQL 用 CAST(... AS TEXT)，所以这里也返回字符串，入口那边的 Decimal 构造路径才一致。
  return rows.reduce((total, row) => total.plus(amountOf(row)), new Prisma.Decimal(0)).toFixed(6)
}

/** `updateMany` 的 data 支持 `{ increment: n }`（`renewBudgetLease` 用它递增 renewCount）。 */
function applyUpdate(row: FakeLedgerRow, data: Record<string, unknown>): void {
  const target = row as unknown as Record<string, unknown>
  for (const [key, value] of Object.entries(data)) {
    if (typeof value === 'object' && value !== null && 'increment' in value) {
      const current = target[key]
      target[key] =
        (typeof current === 'number' ? current : 0) +
        Number((value as { increment: unknown }).increment)
      continue
    }
    target[key] = value
  }
}

export function createFakeTx(options: { now?: Date; rows?: FakeLedgerRow[] } = {}): FakeTx {
  const now = options.now ?? new Date('2026-09-03T12:00:00.000Z')
  // Prisma Client 的客户端时钟：写入口省略时间列时落到这里，与事务时钟差 5 秒。
  // 真实驱动的偏差是几毫秒，放大到 5 秒只是为了断言读起来一眼能看懂。
  const clientClock = new Date(now.getTime() + 5_000)
  const rows = options.rows ?? []
  const audits: FakeAuditRow[] = []
  const calls: string[] = []
  let nextId = rows.length + 1

  const queryRaw = (query: Prisma.Sql): unknown => {
    const text = query.text
    const values = query.values

    if (text.includes('pg_advisory_xact_lock')) {
      calls.push('lock')
      return []
    }
    if (text.includes('CURRENT_TIMESTAMP AS now')) {
      calls.push('now')
      return [{ now }]
    }
    if (text.includes('"poolMonthly"')) {
      calls.push('committed')
      const strings = values.filter((value): value is string => typeof value === 'string')
      const pool = strings.find((value) => poolNames.has(value))
      const tenantId = strings.find((value) => !poolNames.has(value))
      const day = dayWindow(now)
      const month = monthWindow(now)
      const scoped = rows.filter(
        (row) =>
          row.tenantId === tenantId &&
          (row.status === 'RESERVED' || row.status === 'SETTLED') &&
          row.createdAt >= month.start &&
          row.createdAt < month.end,
      )
      return [
        {
          daily: sum(scoped.filter((row) => row.createdAt >= day.start && row.createdAt < day.end)),
          monthly: sum(scoped),
          poolMonthly: sum(scoped.filter((row) => row.pool === pool)),
        },
      ]
    }
    if (text.includes('RETURNING')) {
      calls.push('expire')
      const deadline = values.find((value): value is Date => value instanceof Date)
      const limit = values.find((value): value is number => typeof value === 'number')
      if (deadline === undefined || limit === undefined) {
        throw new Error('假事务：回收语句缺少 now 或 limit 参数')
      }
      return rows
        .filter((row) => row.status === 'RESERVED' && row.leaseExpiresAt <= deadline)
        .sort((a, b) => a.leaseExpiresAt.getTime() - b.leaseExpiresAt.getTime())
        .slice(0, limit)
        .map((row) => {
          row.status = 'EXPIRED'
          row.finalizedAt = now
          return {
            ledgerId: row.id,
            tenantId: row.tenantId,
            reservedAmount: row.reservedAmount.toFixed(6),
            pool: row.pool,
          }
        })
    }
    // 没预料到的语句必须响亮地失败：静默返回 [] 会让入口拿到空结果继续跑。
    throw new Error(`假事务：未预料的原始 SQL：${text}`)
  }

  const fake = {
    $queryRaw: (query: Prisma.Sql) => Promise.resolve(queryRaw(query)),
    modelBudgetLedger: {
      findUnique: (args: {
        where: { tenantId_idempotencyKey: { tenantId: string; idempotencyKey: string } }
      }) => {
        const key = args.where.tenantId_idempotencyKey
        calls.push('findUnique')
        return Promise.resolve(
          rows.find(
            (row) => row.tenantId === key.tenantId && row.idempotencyKey === key.idempotencyKey,
          ) ?? null,
        )
      },
      findFirst: (args: { where: { id: string; tenantId: string } }) => {
        calls.push('findFirst')
        return Promise.resolve(
          rows.find((row) => row.id === args.where.id && row.tenantId === args.where.tenantId) ??
            null,
        )
      },
      create: (args: { data: Record<string, unknown> }) => {
        calls.push('create')
        const created: FakeLedgerRow = {
          ...ledgerRow(),
          id: `row-${String(nextId++)}`,
          createdAt: clientClock,
          answerRunId: null,
          jobId: null,
          ...(args.data as Partial<FakeLedgerRow>),
        }
        rows.push(created)
        return Promise.resolve(created)
      },
      updateMany: (args: {
        where: { id: string; tenantId: string; status?: string }
        data: Record<string, unknown>
      }) => {
        calls.push('updateMany')
        const matched = rows.filter(
          (row) =>
            row.id === args.where.id &&
            row.tenantId === args.where.tenantId &&
            (args.where.status === undefined || row.status === args.where.status),
        )
        for (const row of matched) {
          applyUpdate(row, args.data)
        }
        return Promise.resolve({ count: matched.length })
      },
    },
    domainAuditEvent: {
      create: (args: { data: Record<string, unknown> }) => {
        calls.push('audit')
        const created = {
          id: `audit-${String(audits.length + 1)}`,
          occurredAt: clientClock,
          ...args.data,
        } as FakeAuditRow
        audits.push(created)
        return Promise.resolve(created)
      },
    },
  }

  // 只实现入口实际用到的方法，所以必须过 unknown 断言。Tx 是 Prisma.TransactionClient
  // （去掉了 $transaction 的 deny-list 类型），完整实现它没有意义。
  return { tx: fake as unknown as Tx, rows, audits, calls }
}
