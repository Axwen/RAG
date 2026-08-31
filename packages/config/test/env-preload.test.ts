import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { preloadRootEnv } from '../src/env-preload'

/**
 * DX-T1：.env 预载的加载与优先级语义。
 *
 * 用临时目录伪造仓库根（pnpm-workspace.yaml + .env），不触碰真实仓库配置；
 * 测试后恢复进程环境，避免污染同进程的其他用例。
 */

const overrides: Array<[string, string | undefined]> = []

function setEnv(name: string, value: string | undefined): void {
  overrides.push([name, process.env[name]])
  if (value === undefined) {
    delete process.env[name]
  } else {
    process.env[name] = value
  }
}

afterEach(() => {
  while (overrides.length > 0) {
    const [name, value] = overrides.pop() as [string, string | undefined]
    if (value === undefined) {
      delete process.env[name]
    } else {
      process.env[name] = value
    }
  }
})

function fakeWorkspace(withEnvFile: boolean): string {
  const root = mkdtempSync(path.join(tmpdir(), 'rag-env-preload-'))
  writeFileSync(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n')
  writeFileSync(path.join(root, 'package.json'), '{ "name": "fake" }')
  if (withEnvFile) {
    writeFileSync(
      path.join(root, '.env'),
      '# fake\nENV_PRELOAD_TEST_VAR=from-file\nENV_PRELOAD_EXISTING_VAR=from-file\n',
    )
  }
  // 从子目录启动：验证向上查找 workspace 根
  const nested = path.join(root, 'apps', 'api')
  mkdirSync(nested, { recursive: true })
  return nested
}

describe('preloadRootEnv（DX-T1）', () => {
  it('从子目录向上找到 workspace 根并载入 .env', () => {
    const start = fakeWorkspace(true)
    try {
      setEnv('ENV_PRELOAD_TEST_VAR', undefined)
      preloadRootEnv(start)
      expect(process.env.ENV_PRELOAD_TEST_VAR).toBe('from-file')
    } finally {
      rmSync(path.dirname(path.dirname(start)), { recursive: true, force: true })
    }
  })

  it('不覆盖已存在的外围环境变量', () => {
    const start = fakeWorkspace(true)
    try {
      setEnv('ENV_PRELOAD_EXISTING_VAR', 'from-shell')
      preloadRootEnv(start)
      expect(process.env.ENV_PRELOAD_EXISTING_VAR).toBe('from-shell')
    } finally {
      rmSync(path.dirname(path.dirname(start)), { recursive: true, force: true })
    }
  })

  it('找不到 .env 时静默跳过，不抛出', () => {
    const start = fakeWorkspace(false)
    try {
      setEnv('ENV_PRELOAD_TEST_VAR', undefined)
      expect(() => preloadRootEnv(start)).not.toThrow()
      expect(process.env.ENV_PRELOAD_TEST_VAR).toBeUndefined()
    } finally {
      rmSync(path.dirname(path.dirname(start)), { recursive: true, force: true })
    }
  })
})
