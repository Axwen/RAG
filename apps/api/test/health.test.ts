import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HealthController } from '../src/health/health.controller'
import { HealthService } from '../src/health/health.service'

/** 指向没有监听的端口，用于验证依赖不可用时不会被伪装为可用。 */
const unreachableEnv = {
  DATABASE_URL: 'postgresql://rag:pw@127.0.0.1:1/rag?schema=public',
  OPENSEARCH_NODE: 'http://127.0.0.1:1',
  RABBITMQ_HOST: '127.0.0.1',
  RABBITMQ_PORT: '1',
  REDIS_URL: 'redis://127.0.0.1:1',
  MINIO_ENDPOINT: 'http://127.0.0.1:1',
  KEYCLOAK_BASE_URL: 'http://127.0.0.1:1',
}

beforeEach(() => {
  for (const [key, value] of Object.entries(unreachableEnv)) {
    vi.stubEnv(key, value)
  }
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('存活探针', () => {
  it('只证明进程在跑', () => {
    expect(new HealthService().live()).toEqual({ status: 'ok', service: 'api' })
  })
})

describe('就绪探针', () => {
  it('缺少 DATABASE_URL 时构造即失败', () => {
    vi.stubEnv('DATABASE_URL', '')
    expect(() => new HealthService()).toThrow()
  })

  it('六个中间件全部不可达时整体 down 并给出每项原因', async () => {
    const report = await new HealthService().ready()
    expect(report.status).toBe('down')
    expect(report.dependencies.map((d) => d.name).sort()).toEqual([
      'keycloak',
      'minio',
      'opensearch',
      'postgres',
      'rabbitmq',
      'redis',
    ])
    for (const dependency of report.dependencies) {
      expect(dependency.status).toBe('down')
      expect(dependency.reason).toBeDefined()
    }
  }, 30_000)

  it('整体 down 时控制层返回 503，不返回 200', async () => {
    const json = vi.fn()
    const status = vi.fn().mockReturnValue({ json })
    const controller = new HealthController(new HealthService())
    await controller.ready({ status } as never)
    expect(status).toHaveBeenCalledWith(503)
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ status: 'down' }))
  }, 30_000)
})
