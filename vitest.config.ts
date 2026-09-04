import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const root = dirname(fileURLToPath(import.meta.url))

/**
 * 跨包 import 解析到**编译产物**，不是源码：vite 按 Node 规则把
 * `from '@rag/contracts'` 落到该包 package.json 的 main（`dist/index.js`），只有当前
 * 包的源文件才由 vitest 现场转译。所以全新克隆里 `pnpm test` 有 6 个测试文件根本加载
 * 不起来（129 → 80 个测试静默变少），vite 报的却是
 *   Failed to resolve entry for package "@rag/config".
 *   The package may have incorrect main/module/exports specified in its package.json.
 * ——把人指向 package.json 的 exports 字段，而真正缺的只是一次 build。
 *
 * CI 首跑第二轮就是这样红的：quality job 只装依赖就跑覆盖率，而 node job 恰好因为
 * `typecheck` 也是 `tsc -b`（会 emit）才没暴露这条依赖。与 seed 缺 dist 是同一个根因：
 * 本地长期有历次构建的残留，掩盖了"测试需要先构建"这件事。
 *
 * 与其让下一个人去查 exports 字段，这里提前失败并说清怎么办。
 */
const unbuilt = readdirSync(join(root, 'packages'), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => join(root, 'packages', entry.name, 'package.json'))
  .filter((manifestPath) => existsSync(manifestPath))
  .map((manifestPath) => ({
    dir: dirname(manifestPath),
    manifest: JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      main?: string
      scripts?: Record<string, string>
    },
  }))
  // 只查"声明了 main 且有 build 脚本"的包：将来若加入无需构建的包，这里不该误报
  .filter(({ manifest }) => manifest.main !== undefined && manifest.scripts?.build !== undefined)
  .map(({ dir, manifest }) => resolve(dir, manifest.main as string))
  .filter((entryPoint) => !existsSync(entryPoint))

if (unbuilt.length > 0) {
  const list = unbuilt.map((p) => `  - ${relative(root, p)}`).join('\n')
  throw new Error(
    `工作区包尚未构建，跨包 import 会解析失败：\n${list}\n` +
      '先跑 `pnpm run build`（或 `pnpm --filter "./packages/*" run build`）再跑测试。',
  )
}

export default defineConfig({
  test: {
    projects: ['apps/*', 'packages/*'],
    coverage: {
      provider: 'v8',
      reportsDirectory: 'coverage',
      reporter: ['text', 'lcov', 'json-summary'],
      // 覆盖率只对"我们自己写的、能被单测触达的"代码负责
      exclude: [
        '**/dist/**',
        '**/generated/**', // Prisma Client 生成产物
        '**/*.config.*',
        '**/test/**',
        '**/prisma/seed.ts', // 开发种子，由 bootstrap 真实执行验证
        '**/apps/web/**', // 前端从 T16a 起有页面，届时改用 Playwright 计入
      ],
      /**
       * 阈值是棘轮而不是理想值：取当前实测值下取整一档，只允许往上调。
       * 目的是拦住"新增未测代码把整体拉下来"，不是给一个漂亮数字。
       * 实测基线 2026-09-04（23 文件 / 262 测试，已排除生成产物），vite 8.2.2：
       *   statements 90.56 / branches 86.28 / functions 87.85 / lines 91.18
       * 留约一个点的余量：**分母随转译器变**——同一份代码在 vite 7.3.6 下的上一版基线量到
       * branches 82.43 而 vite 8 量到 81.97（vite 8 换 Oxc/Rolldown，转译出的语句/分支形状
       * 与 esbuild 不同）。贴着实测值定阈值会让一次无关的工具链升级把门禁弄红。
       * 为什么 vite 8 下 functions 分母多了 3 个、以及那 3 个是怎么补上的，见 CHANGELOG 里
       * vite 8 那条。
       *
       * 这一档是 T12a 第三片抬上来的（86/81/82/87 → 89/85/86/90）：事务入口与审计写入口
       * 各自带了单元层用例，不抬棘轮的话，以后删掉其中一半仍然能过。
       */
      thresholds: {
        statements: 89,
        branches: 85,
        functions: 86,
        lines: 90,
      },
    },
  },
})
