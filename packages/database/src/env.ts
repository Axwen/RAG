/** Prisma schema 相对本包根目录的位置，供脚本与文档引用同一事实。 */
export const PRISMA_SCHEMA_PATH = 'prisma/schema.prisma' as const

/** 迁移目录。迁移 SQL 必须进入版本库。 */
export const PRISMA_MIGRATIONS_PATH = 'prisma/migrations' as const

/** 唯一连接串环境变量名。禁止在代码中内联连接串。 */
export const DATABASE_URL_ENV = 'DATABASE_URL' as const

/**
 * 读取数据库连接串。
 *
 * 缺失即抛出：中间件不可用时必须明确失败，不得伪装为可用（T0 验收）。
 */
export function requireDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const value = env[DATABASE_URL_ENV]
  if (value === undefined || value.trim() === '') {
    throw new Error(`缺少环境变量 ${DATABASE_URL_ENV}：数据库连接串只能来自运行环境或未跟踪的 .env`)
  }
  return value
}
