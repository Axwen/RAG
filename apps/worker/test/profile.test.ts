import { describe, expect, it } from 'vitest'
import { loadWorkerRuntimeConfig, resolveProfile } from '../src/profile'

const baseEnv: NodeJS.ProcessEnv = {
  DATABASE_URL: 'postgresql://rag:pw@localhost:5432/rag?schema=public',
}

describe('Worker Profile 解析', () => {
  it('缺省不提供默认 Profile，必须显式指定', () => {
    expect(() => resolveProfile(undefined)).toThrow(/WORKER_PROFILE/)
    expect(() => resolveProfile('  ')).toThrow(/WORKER_PROFILE/)
  })

  it('未知 Profile 被拒绝', () => {
    expect(() => resolveProfile('api')).toThrow(/未知 WORKER_PROFILE/)
  })

  it('两个合法 Profile 被接受', () => {
    expect(resolveProfile('ingestion')).toBe('ingestion')
    expect(resolveProfile(' evaluation ')).toBe('evaluation')
  })
})

describe('Worker 运行时边界', () => {
  it('ingestion 为并发 4 / in-flight 8', () => {
    const config = loadWorkerRuntimeConfig({ ...baseEnv, WORKER_PROFILE: 'ingestion' })
    expect(config.concurrency).toBe(4)
    expect(config.inFlight).toBe(8)
  })

  it('evaluation 为并发 1 / in-flight 1', () => {
    const config = loadWorkerRuntimeConfig({ ...baseEnv, WORKER_PROFILE: 'evaluation' })
    expect(config.concurrency).toBe(1)
    expect(config.inFlight).toBe(1)
  })

  it('健康端口可配置，默认 3002', () => {
    expect(loadWorkerRuntimeConfig({ ...baseEnv, WORKER_PROFILE: 'ingestion' }).healthPort).toBe(
      3002,
    )
    expect(
      loadWorkerRuntimeConfig({
        ...baseEnv,
        WORKER_PROFILE: 'ingestion',
        WORKER_HEALTH_PORT: '4002',
      }).healthPort,
    ).toBe(4002)
  })

  it.each(['abc', '0', '65536'])('非法健康端口 %s 会在启动阶段被拒绝', (healthPort) => {
    expect(() =>
      loadWorkerRuntimeConfig({
        ...baseEnv,
        WORKER_PROFILE: 'ingestion',
        WORKER_HEALTH_PORT: healthPort,
      }),
    ).toThrow(/WORKER_HEALTH_PORT/)
  })

  it('依赖配置缺失时启动即失败', () => {
    expect(() => loadWorkerRuntimeConfig({ WORKER_PROFILE: 'ingestion' })).toThrow()
  })
})
