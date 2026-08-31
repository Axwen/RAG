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
