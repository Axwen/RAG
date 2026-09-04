import type { Prisma } from './generated/prisma/client'

/**
 * 已开启的事务句柄。
 *
 * 名字取自 T11a 的[审计写入口契约]与 T12 的[事务入口契约]，两处都写 `type Tx =
 * Prisma.TransactionClient`，这里只做一次。审计写入与业务写入必须在同一个 `tx` 上，
 * 这样 ADR-0035 第 13 行的「审计写失败则业务失败」由类型和事务共同保证，而不是靠评审提醒。
 *
 * 句柄类型排除了 `$transaction` 等客户端级方法（Prisma 的 `ITXClientDenyList`），
 * 所以入口拿不到「再开一个事务」的能力：嵌套事务会让审计与业务落在两个事务里。
 */
export type Tx = Prisma.TransactionClient
