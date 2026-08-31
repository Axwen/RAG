import { existsSync } from 'node:fs'
import path from 'node:path'
import { config as loadDotenv } from 'dotenv'

/**
 * 预载仓库根目录的 .env（devex 评审 DX-T1，并入 T1a）。
 *
 * 新终端无需手工 `set -a; source .env; set +a`：应用入口在解析任何依赖配置前
 * 调用本函数。dotenv 不覆盖已存在的进程环境变量，因此 CI、部署或外围 shell
 * 显式注入的值始终优先。
 *
 * 只在仓库根（pnpm-workspace.yaml 所在目录）查找 .env，与 Compose、prisma
 * 共用同一份文件；找不到 .env 时静默跳过，让后续配置解析报出缺失变量。
 */
export function preloadRootEnv(startDir: string = process.cwd()): void {
  const root = findWorkspaceRoot(path.resolve(startDir))
  const envFile = path.join(root, '.env')
  if (existsSync(envFile)) {
    loadDotenv({ path: envFile, quiet: true })
  }
}

function findWorkspaceRoot(start: string): string {
  let current = start
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
