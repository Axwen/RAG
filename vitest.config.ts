import { defineConfig } from 'vitest/config'

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
       * 实测基线 2026-09-01（16 文件 / 129 测试，已排除生成产物）：
       *   statements 87.15 / branches 82.43 / functions 83.16 / lines 87.83
       */
      thresholds: {
        statements: 86,
        branches: 81,
        functions: 82,
        lines: 86,
      },
    },
  },
})
