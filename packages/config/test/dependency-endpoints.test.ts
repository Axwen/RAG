import { describe, expect, it } from 'vitest'
import {
  loadDependencyEndpoints,
  oidcDiscoveryUrl,
  parsePort,
  parseRedisUrl,
} from '../src/dependency-endpoints'

const minimalEnv: NodeJS.ProcessEnv = {
  DATABASE_URL: 'postgresql://rag:pw@localhost:5432/rag?schema=public',
}

describe('依赖接入点解析', () => {
  it('缺少 DATABASE_URL 时启动即失败', () => {
    expect(() => loadDependencyEndpoints({})).toThrow()
  })

  it('其余变量有本地默认值', () => {
    const endpoints = loadDependencyEndpoints(minimalEnv)
    expect(endpoints.opensearchNode).toBe('http://localhost:9200')
    expect(endpoints.opensearchRequestTimeoutMs).toBe(250)
    expect(endpoints.rabbitmqPort).toBe(5672)
    expect(endpoints.rabbitmqManagementPort).toBe(15672)
    expect(endpoints.redisHost).toBe('localhost')
    expect(endpoints.redisPort).toBe(6379)
    expect(endpoints.keycloakRealm).toBe('rag-local')
  })

  it('OpenSearch 请求超时不得超过 250 ms', () => {
    expect(() =>
      loadDependencyEndpoints({ ...minimalEnv, OPENSEARCH_REQUEST_TIMEOUT_MS: '1000' }),
    ).toThrow()
  })

  it('非法 URL 直接拒绝', () => {
    expect(() => loadDependencyEndpoints({ ...minimalEnv, MINIO_ENDPOINT: 'not-a-url' })).toThrow()
  })
})

describe('Redis 连接串', () => {
  it('解析 host 与显式端口', () => {
    expect(parseRedisUrl('redis://cache:6380')).toEqual({ host: 'cache', port: 6380 })
  })

  it('缺省端口回落 6379', () => {
    expect(parseRedisUrl('redis://cache')).toEqual({ host: 'cache', port: 6379 })
  })

  it('不受支持的协议直接拒绝', () => {
    expect(() => parseRedisUrl('http://cache:6379')).toThrow(/协议/)
  })
})

describe('端口解析', () => {
  it('接受字符串形式的合法端口', () => {
    expect(parsePort('3001', 'API_PORT')).toBe(3001)
  })

  it.each(['abc', '0', '-1', '65536', '1.5'])('拒绝非法端口 %s', (value) => {
    expect(() => parsePort(value, 'API_PORT')).toThrow(/API_PORT/)
  })
})

describe('OIDC discovery 地址', () => {
  it('拼接 realm 且容忍尾部斜杠', () => {
    const expected = 'http://localhost:8080/realms/rag-local/.well-known/openid-configuration'
    expect(oidcDiscoveryUrl('http://localhost:8080', 'rag-local')).toBe(expected)
    expect(oidcDiscoveryUrl('http://localhost:8080///', 'rag-local')).toBe(expected)
  })
})
