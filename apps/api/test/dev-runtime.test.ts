import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * 锁定开发入口的转译器与文件监听方式。
 *
 * 1. NestJS 的构造函数注入依赖 `emitDecoratorMetadata` 生成的 design:paramtypes。
 *    esbuild 系转译器（tsx）不产出这份元数据：进程照常启动、路由照常注册，但注入
 *    进来的依赖是 undefined，于是每个请求都 500。单测直接 new 领域服务、绕过 DI，
 *    抓不到这个回归。
 * 2. Node 22 的 `--watch` 会跟踪入口及其导入模块，足以覆盖 API 开发入口的热重载。
 */
describe('apps/api 开发入口', () => {
  const packageRoot = join(__dirname, '..')
  const pkg = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>
    devDependencies: Record<string, string>
  }

  it('dev 用支持 emitDecoratorMetadata 的转译器，不用 esbuild 系', () => {
    expect(String(pkg.scripts.dev)).toContain('ts-node')
    expect(String(pkg.scripts.dev)).not.toContain('tsx')
    expect(pkg.devDependencies['ts-node']).toBeDefined()
  })

  it('dev 使用 Node 原生 watch，避免额外 watcher 依赖', () => {
    expect(String(pkg.scripts.dev)).toMatch(/^node --watch/)
    expect(String(pkg.scripts.dev)).toContain('ts-node/register/transpile-only')
    expect(pkg.devDependencies['nodemon']).toBeUndefined()
  })

  it('tsconfig 打开装饰器元数据', () => {
    const tsconfig = JSON.parse(readFileSync(join(packageRoot, 'tsconfig.json'), 'utf8')) as {
      compilerOptions: Record<string, unknown>
    }
    expect(tsconfig.compilerOptions.emitDecoratorMetadata).toBe(true)
    expect(tsconfig.compilerOptions.experimentalDecorators).toBe(true)
  })
})
