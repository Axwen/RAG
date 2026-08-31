import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * 锁定开发入口的转译器与文件监听方式。
 *
 * 1. NestJS 的构造函数注入依赖 `emitDecoratorMetadata` 生成的 design:paramtypes。
 *    esbuild 系转译器（tsx）不产出这份元数据：进程照常启动、路由照常注册，但注入
 *    进来的依赖是 undefined，于是每个请求都 500。单测直接 new 领域服务、绕过 DI，
 *    抓不到这个回归。
 * 2. `node --watch` 在 Linux 上按解析后的文件路径注册 watcher。编辑器的原子保存
 *    （写临时文件 + rename）会换掉 inode，watcher 留在旧 inode 上：实测 Node
 *    v22.23.1 连续 4 次原子保存只重启 1 次，之后改代码不生效、旧进程继续服务，
 *    表现为调试一个已经改掉的现象。`--watch-path` 只在 macOS/Windows 可用。
 *    因此 dev 必须用目录监听（nodemon，实测同样 4 次原子保存重启 4 次）。
 * 3. 目录监听换来的代价是监听范围要自己列全。`node --watch` 跟踪整个已解析模块图，
 *    包含各 workspace 包的 dist；nodemon 只看给定目录，漏掉一个包就等于把同一个
 *    "调试一个已经改掉的现象"从 src 搬到那个包里。因此每个 workspace 包的 dist
 *    都必须在 watch 列表内，新增包时由本测试挡住漏配。
 *    （watch 路径里写 shell 通配符实测不生效，必须逐个写明目录。）
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

  it('dev 用目录监听，原子保存后热重载不止一次', () => {
    expect(String(pkg.scripts.dev)).toMatch(/^nodemon --watch src/)
    expect(String(pkg.scripts.dev)).not.toContain('node --watch')
    expect(pkg.devDependencies['nodemon']).toBeDefined()
  })

  it('每个 workspace 包的 dist 都在 dev 的监听范围内', () => {
    const packagesDir = join(packageRoot, '..', '..', 'packages')
    const workspacePackages = readdirSync(packagesDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
    expect(workspacePackages.length).toBeGreaterThan(0)
    for (const name of workspacePackages) {
      expect(String(pkg.scripts.dev)).toContain(`--watch ../../packages/${name}/dist`)
    }
    // dist 里既有 .js 也有 .d.ts，两者都要能触发重启
    expect(String(pkg.scripts.dev)).toContain('--ext ts,js')
  })

  it('tsconfig 打开装饰器元数据', () => {
    const tsconfig = JSON.parse(readFileSync(join(packageRoot, 'tsconfig.json'), 'utf8')) as {
      compilerOptions: Record<string, unknown>
    }
    expect(tsconfig.compilerOptions.emitDecoratorMetadata).toBe(true)
    expect(tsconfig.compilerOptions.experimentalDecorators).toBe(true)
  })
})
