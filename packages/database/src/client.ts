import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from './generated/prisma/client'
import { requireDatabaseUrl } from './env'

/**
 * 创建带 pg driver adapter 的 PrismaClient（Prisma 7 运行时连接方式）。
 *
 * 连接串只来自运行环境或未跟踪的 .env，本函数不持有任何默认值；缺失即抛出。
 * API/Worker 各自持有实例并在关闭钩子里断开，不跨进程共享。
 */
export function createPrismaClient(
  options: { readonly connectionString?: string } = {},
): PrismaClient {
  const connectionString = options.connectionString ?? requireDatabaseUrl()
  return new PrismaClient({
    adapter: new PrismaPg({ connectionString }),
  })
}

export { PrismaClient } from './generated/prisma/client'

/**
 * `Prisma` 命名空间，只为一件事导出：调用方需要它才能构造 `Cny`（= `Prisma.Decimal`）。
 *
 * 五条预算入口的签名要求金额是 `Prisma.Decimal`（列是 `@db.Decimal(12, 6)`，浮点会让
 * 一个月的账本行累加出对不上的账），而 `@rag/config` 的估值函数返回 `number`——那一次
 * `new Prisma.Decimal(...)` 转换发生在调用侧。不从这里导出，调用方就只能 import
 * `@rag/database/dist/generated/prisma/client`，那才是真的把生成产物的路径变成公共契约。
 *
 * 导出的是构造 `Decimal` 与 `Prisma.sql` 所需的那个命名空间，不是表结构：模型委托仍然
 * 只在 `PrismaClient` 上，业务模块拿不到「自己拼 SQL 改账本」的入口。
 */
export { Prisma } from './generated/prisma/client'
