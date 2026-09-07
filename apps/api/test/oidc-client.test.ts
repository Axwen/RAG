import { afterAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { parseAuthConfig } from '../src/auth/auth.config'
import { KeycloakUnavailableError, OidcClient } from '../src/auth/oidc-client'

/**
 * 身份服务不可用与恢复（七类场景之余二）。
 *
 * 这两类不碰真实 Keycloak：被验证的是 OidcClient 把网络层错误收敛成
 * KeycloakUnavailableError（→503）这一行为，本地桩服务器就是那个
 * 「可关可开的身份服务」——起停共享容器来演戏反而测不到收敛逻辑本身。
 *
 * 端口选择是环境事实，不是随手的数：
 * - 本机（WSL2）对未监听的低端口立即 RST、对高位端口丢 SYN——后者 fetch
 *   会挂到默认 10 秒以上，这正是超时配置存在的原因，用 1 秒超时的黑洞
 *   用例把它钉住。
 * - 桩服务器必须绑高位端口（低端口无 root 不可监听）。
 */

const servers: Server[] = []

function listen(port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      if (req.url?.includes('/token') === true) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ id_token: 'stub', access_token: 'stub' }))
        return
      }
      res.writeHead(404)
      res.end()
    })
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolve(server))
    servers.push(server)
  })
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close(() => resolve())
    server.once('error', reject)
  })
}

const STUB_PORT = 38_921

function clientFor(port: number, timeoutMs = 5_000): OidcClient {
  const config = parseAuthConfig({
    AUTH_SESSION_SECRET: 'unit-test-session-secret-0123456789abcdef',
    AUTH_REQUEST_TIMEOUT_MS: String(timeoutMs),
    KEYCLOAK_BASE_URL: `http://127.0.0.1:${port}`,
    KEYCLOAK_REALM: 'rag-local',
  })
  return new OidcClient(config)
}

afterAll(async () => {
  for (const server of servers.splice(0)) {
    await close(server).catch(() => undefined)
  }
})

describe('OidcClient：身份服务不可用与恢复', () => {
  it('连接被拒时收敛为 KeycloakUnavailableError（映射 503）', async () => {
    // 低端口（无监听）在本机立即 RST：ECONNREFUSED 是 TypeError，必须被收敛。
    const client = clientFor(9)
    await expect(client.exchangeCode('code', 'verifier')).rejects.toBeInstanceOf(
      KeycloakUnavailableError,
    )
  })

  it('网络黑洞（SYN 被丢）在配置的超时内收敛，不挂默认 10 秒', async () => {
    // 高位端口未监听时本机丢 SYN；1 秒超时把它变成确定的失败。
    const client = clientFor(STUB_PORT, 1_000)
    const start = Date.now()
    await expect(client.exchangeCode('code', 'verifier')).rejects.toBeInstanceOf(
      KeycloakUnavailableError,
    )
    expect(Date.now() - start).toBeLessThan(5_000)
  }, 10_000)

  it('身份服务恢复后，同一客户端实例完成 token 交换；再次掉线再次收敛', async () => {
    const client = clientFor(STUB_PORT, 1_000)
    await expect(client.exchangeCode('code', 'verifier')).rejects.toBeInstanceOf(
      KeycloakUnavailableError,
    )

    const server = await listen(STUB_PORT)
    try {
      // 恢复后的第一次调用就应成功——OidcClient 不缓存「上次失败」状态。
      await expect(client.exchangeCode('code', 'verifier')).resolves.toEqual({
        idToken: 'stub',
        accessToken: 'stub',
      })
    } finally {
      await close(server)
    }

    await expect(client.exchangeCode('code', 'verifier')).rejects.toBeInstanceOf(
      KeycloakUnavailableError,
    )
  }, 15_000)

  it('token 端点可达但拒绝请求（HTTP 400）时抛普通错误，不是依赖不可用', async () => {
    const server = createServer((req, res) => {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end('{"error":"invalid_grant"}')
    })
    await new Promise<void>((resolve) => server.listen(STUB_PORT + 1, '127.0.0.1', resolve))
    servers.push(server)
    try {
      const client = clientFor(STUB_PORT + 1)
      await expect(client.exchangeCode('code', 'verifier')).rejects.toThrow(/token 端点拒绝/)
    } finally {
      await close(server)
    }
  })
})
