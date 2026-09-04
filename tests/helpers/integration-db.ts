import { randomUUID } from 'node:crypto'
import { Prisma, type PrismaClient, createPrismaClient } from '@rag/database'
import type { BudgetLimits, Cny } from '@rag/database'

/**
 * 集成层的共享夹具。
 *
 * 通过**包名**（`@rag/database`）import：这一层要验的正是「调用方只拿到包根导出的那几个函数」
 * 这条表面，而不是内部文件的行为——那一侧由 `packages/database/test/` 的单元测试覆盖。
 * 仓库根因此在 devDependencies 里声明了 `@rag/database` 与 `@rag/config`：集成层是这两个包的
 * 外部消费者，不是它们的内部。
 */

/** 金额构造。`Cny` 就是 `Prisma.Decimal`，`@rag/database` 导出 `Prisma` 就是为了这一次转换。 */
export function cny(value: string): Cny {
  return new Prisma.Decimal(value)
}

/** 幂等键。同一个用例里要造「不同调用」就得换键，撞键的语义是重放而不是新调用。 */
export function idempotencyKey(label: string): string {
  return `integration-${label}-${randomUUID()}`
}

/** 归属列的值。`answerRunId` 是裸 `@db.Uuid`（AnswerRun 归 T7，表还不存在），所以随便一个 uuid 都行。 */
export function answerRunId(): string {
  return randomUUID()
}

/**
 * 基准上限。很小，让边界用一位小数就能撞到（与单元层同一个理由）。
 *
 * 三池之和等于月度上限这条口径保持——配置 schema 的 refine 就是这么校验的（ADR-0029），
 * 夹具里破坏它会让测试在验一个配置层根本产生不出来的形状。用例要更紧的边界时按需覆盖单个字段
 * （`{ ...integrationLimits, dailyCny: 1 }`），改月度上限时记得同时改池。
 */
export const integrationLimits: BudgetLimits = {
  singleCallCny: 1,
  dailyCny: 2,
  monthlyCny: 10,
  pools: { interactive: 6, evaluation: 3, reserve: 1 },
  lease: { defaultSeconds: 60, maxRenewSeconds: 60, maxTotalSeconds: 600 },
}

/**
 * 一个连接池、一批租户。
 *
 * 租户是逐个用例新建的：预扣的四层 CAS 按租户 + 时间窗求和，共用租户会让上一个用例的
 * `RESERVED` 行变成下一个用例的「已用额度」，那种串味的失败极难读。
 */
export class IntegrationDb {
  readonly prisma: PrismaClient
  private readonly tenantIds: string[] = []

  constructor() {
    this.prisma = createPrismaClient()
  }

  /** 新建一个只属于本用例的租户。名字带前缀，万一残留也能一眼认出是测试数据。 */
  async createTenant(label: string): Promise<string> {
    const tenant = await this.prisma.tenant.create({
      data: { name: `integration-${label}-${randomUUID().slice(0, 8)}` },
      select: { id: true },
    })
    this.tenantIds.push(tenant.id)
    return tenant.id
  }

  /** 本次运行创建的租户，给需要「除了我自己」谓词的前置检查用。 */
  ownedTenantIds(): readonly string[] {
    return this.tenantIds
  }

  /**
   * 只删账本行，不删审计行也不删租户。这个不对称是库层不变量的直接结果，不是偷懒：
   *
   * - **账本行必须删。** `expireBudgetLeases` 不带 `tenantId`（回收是全局任务），上一轮留下的
   *   `RESERVED` 行会混进下一轮的回收批次，把「按 leaseExpiresAt 升序、被 limit 截断」变成
   *   偶尔红一次的谜题。删除本身是允许的：状态机触发器是 `BEFORE UPDATE`，不管 DELETE。
   * - **审计行删不掉。** 触发器 `domain_audit_event_append_only` 对行级 UPDATE/DELETE 直接
   *   抛 `check_violation`（ADR-0040 决策 5）。迁移里写着 TRUNCATE 不触发行级触发器，所以清库
   *   路径「仍然通畅」——但那是清库，不是清一个租户；这里不用它，测试不该有应用代码没有的后门。
   * - **租户跟着删不掉。** 审计行到 `tenants` 的外键是 `ON DELETE RESTRICT`，留着审计行就留着
   *   租户。代价是几行两列的残留（CI 里每次都是全新容器），换来的是审计不可变这条不变量在
   *   测试路径上也成立。
   */
  async cleanup(): Promise<void> {
    await this.clearLedger()
    this.tenantIds.length = 0
    await this.prisma.$disconnect()
  }

  /**
   * 清掉本文件已创建租户的全部账本行，租户本身留着。
   *
   * 回收用例要在 `afterEach` 里调它：`expireBudgetLeases` 的候选集是全局的，同一个文件里
   * 前一个用例留下的 `RESERVED` 行属于「我们自己的」租户，`assertNoForeignReservedRows`
   * 抓不到它，但它一样会混进「按 leaseExpiresAt 升序、被 limit 截断」的批次断言。
   */
  async clearLedger(): Promise<void> {
    if (this.tenantIds.length > 0) {
      await this.prisma.modelBudgetLedger.deleteMany({
        where: { tenantId: { in: this.tenantIds } },
      })
    }
  }
}

/**
 * 一次性闸门：`wait` 一直挂着，直到有人调 `open()`。
 *
 * 用来让「一个事务持着行锁，另一个事务同时跑回收」这件事变确定：靠 `setTimeout` 猜对方
 * 是否已经拿到锁，会在 CI 上变成偶发失败。`open` 的初值故意是抛异常而不是空函数——
 * 真的忘了接线时会炸，而不是安静地让 `wait` 永远挂到超时。
 */
export function latch(): { wait: Promise<void>; open: () => void } {
  let open: () => void = () => {
    throw new Error('latch 尚未初始化：Promise 的执行器是同步的，走到这里说明接线错了')
  }
  const wait = new Promise<void>((resolve) => {
    open = resolve
  })
  return { wait, open }
}

/**
 * 断言库里没有别人留下的 `RESERVED` 行。
 *
 * 回收任务的判据时间由调用方给（`expireBudgetLeases(tx, { now, limit })`），用例会传一个未来的
 * `now` 来免掉真实等待——于是**任何**别人留下的 `RESERVED` 行都会落进候选集，不只是此刻已过期的。
 * 与其让批次断言偶发失败，不如在用例开始时把「库不干净」直接说出来。
 */
export async function assertNoForeignReservedRows(
  prisma: PrismaClient,
  ownTenantIds: readonly string[],
): Promise<void> {
  const foreign = await prisma.modelBudgetLedger.count({
    where: { status: 'RESERVED', tenantId: { notIn: [...ownTenantIds] } },
  })
  if (foreign > 0) {
    throw new Error(
      `集成库里还有 ${foreign} 条属于其他租户的 RESERVED 行：回收任务是全局的，它们会混进本用例的` +
        '批次。先清掉残留（`pnpm run infra:reset && pnpm run infra:up && pnpm run bootstrap`），' +
        '或确认没有别的测试在同一个库上跑。',
    )
  }
}
