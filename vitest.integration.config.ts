import { existsSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const root = dirname(fileURLToPath(import.meta.url))

/**
 * 集成层通过**包名**（`@rag/database`）import，走的是 index.ts 的公开表面——那正是
 * T12 [事务入口契约] 说的「只从包根导出这五个函数」。代价是它和 `vitest.config.ts` 顶部
 * 那段一样，依赖 dist：没构建时 vite 报的是 `Failed to resolve entry for package`，
 * 把人指向 exports 字段，而真正缺的只是一次构建。
 *
 * 这个检查放在配置里而不是 `tests/setup.ts` 里，是为了保证顺序：配置先于任何测试文件求值，
 * 所以它一定在 `@rag/config` 被 import 之前抛出，不需要靠动态 import 或顶层 await 排序。
 */
const required = ['packages/config/dist/index.js', 'packages/database/dist/index.js'].map((entry) =>
  join(root, entry),
)
const unbuilt = required.filter((entry) => !existsSync(entry))
if (unbuilt.length > 0) {
  const list = unbuilt.map((entry) => `  - ${relative(root, entry)}`).join('\n')
  throw new Error(
    `集成测试通过包名 import 工作区包，但这些构建产物不存在：\n${list}\n` +
      '先跑 `pnpm run build`，再跑 `pnpm run test:integration`。',
  )
}

/**
 * 集成层测试（`tests/`）。与 `vitest.config.ts` 分开跑，不是为了整洁，是因为两层的前提不同：
 * 单元层只要有 Node，集成层要有一个已迁移的 PostgreSQL。混在一条命令里，新克隆的
 * `pnpm test` 就会因为没起容器而红，把「代码错了」和「环境没起」混成同一个信号。
 *
 * 三处刻意的差异：
 * - **不设覆盖率阈值。** 覆盖率棘轮量的是单元层能触达多少代码；集成层跑的是真库行为，
 *   把它的数字并进去只会让阈值虚高，掩盖单元层的空洞。
 * - **`fileParallelism: false`。** 所有文件共用同一个库。并行会让 A 文件的租户清理撞上
 *   B 文件正在跑的窗口求和，而 `SKIP LOCKED` 那条用例要故意长时间持锁。
 * - **`testTimeout` 放到 30s。** 并发预扣要真的在 advisory lock 上排队，持锁用例还要等
 *   另一个事务提交，5s 默认值不够。
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
    // 共用一个库：文件之间必须串行，文件内的用例本来就是顺序执行的。
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
