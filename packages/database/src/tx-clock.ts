import { Prisma } from './generated/prisma/client'
import type { Tx } from './tx'

/**
 * 事务时钟。放在包根而不是 `budget/`，是因为审计入口也要用它：审计与账本必须读同一口时钟，
 * 而 `audit/` 不该 import `budget/`（两者由不同 ticket 交付，T11a 先于 T12a）。
 *
 * 这个文件**不**在 `index.ts` 的导出清单里：调用方拿到的表面是那几个事务入口，不包括时钟。
 */

/**
 * 事务开始时间，由数据库给。
 *
 * PostgreSQL 的 `CURRENT_TIMESTAMP` 返回**事务开始时间**，在事务内稳定。这一条让四层 CAS 的
 * 窗口边界、`leaseExpiresAt`、账本行的 `createdAt` 与审计行的 `occurredAt` 取到同一个时刻——
 * 否则一次预扣可能按今天的窗口校验、落到明天的 `createdAt` 上，跨零点的那一次调用就绕过了日限。
 *
 * 不用 `new Date()`：应用时钟与数据库时钟的偏差会变成同一类跨窗口漏洞，而且多个 API 实例
 * 的偏差各不相同。**也不能靠列的 `DEFAULT CURRENT_TIMESTAMP`**：Prisma Client 会在客户端为
 * `@default(now())` 生成值再发过去，列默认值只对省略该列的写入者（比如原始 SQL）生效——
 * 于是同一个事务里两次 `create()` 会差几毫秒，正好是上面那个漏洞。列默认值留着当兜底，
 * 走 Client 的入口一律显式传这里的值。
 */
export async function txNow(tx: Tx): Promise<Date> {
  const rows = await tx.$queryRaw<Array<{ now: Date }>>(Prisma.sql`SELECT CURRENT_TIMESTAMP AS now`)
  const now = rows[0]?.now
  if (now === undefined) {
    throw new Error('读取事务时间失败：账本入口不得在拿不到时钟的情况下继续')
  }
  return now
}
