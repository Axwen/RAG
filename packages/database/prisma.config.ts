import { existsSync } from 'node:fs'
import path from 'node:path'
import { config as loadDotenv } from 'dotenv'
import { defineConfig, env } from 'prisma/config'

/**
 * Prisma 7 CLI 配置。
 *
 * 迁移策略（T0 冻结）：本地开发用 `prisma migrate dev`，CI 与部署用
 * `prisma migrate deploy`；迁移 SQL 进入版本库，不使用 `db push` 代替正式迁移。
 * 连接串只来自未跟踪的 .env 或运行环境，仓库内不存放真实凭证。
 *
 * 环境变量来源：仓库根的 .env（与 Compose、各应用共用同一份），而不是本包目录下的
 * .env。dotenv 不覆盖已存在的进程环境变量，因此 CI 或部署直接注入 DATABASE_URL
 * 时以运行环境为准。仓库根目录通过 workspace 标记向上查找，不依赖包目录层级的
 * 硬编码相对路径。
 */
function findWorkspaceRoot(start: string): string {
  let current = path.resolve(start)
  while (true) {
    if (
      existsSync(path.join(current, 'pnpm-workspace.yaml')) &&
      existsSync(path.join(current, 'package.json'))
    ) {
      return current
    }
    const parent = path.dirname(current)
    if (parent === current) {
      return start
    }
    current = parent
  }
}

loadDotenv({ path: path.join(findWorkspaceRoot(__dirname), '.env'), quiet: true })

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: env('DATABASE_URL'),
  },
})
