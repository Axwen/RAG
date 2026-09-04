import { join } from 'node:path'
import { preloadRootEnv } from '@rag/config'

/**
 * 集成层的运行环境。
 *
 * `preloadRootEnv()` 读仓库根的 `.env`（与 Compose、Prisma 共用同一份，DX-T1），所以
 * 跑集成测试不需要先 `set -a; source .env`。dotenv 不覆盖已存在的进程环境变量，CI 里
 * 显式注入的值优先。
 *
 * 缺 `DATABASE_URL` 时在这里就失败：`requireDatabaseUrl()` 的报错只说「缺少环境变量」，
 * 它没说这一层要的是一个**已迁移**的库。把起容器的那两条命令直接写进错误信息里，比让人
 * 去翻 README 快。
 */
preloadRootEnv(join(__dirname, '..'))

const connectionString = process.env['DATABASE_URL']
if (connectionString === undefined || connectionString.trim() === '') {
  throw new Error(
    '集成测试需要一个已迁移的 PostgreSQL，但 DATABASE_URL 为空。\n' +
      '本地：cp .env.example .env && pnpm run infra:up && pnpm run bootstrap',
  )
}
