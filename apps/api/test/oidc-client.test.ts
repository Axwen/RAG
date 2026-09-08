import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseAuthConfig } from '../src/auth/auth.config'
import { KeycloakUnavailableError, OidcClient } from '../src/auth/oidc-client'

/**
 * 身份服务不可用与恢复（七类场景之余二）。
 *
 * 不绑定本地端口：这些用例只验证 OidcClient 将 Keycloak 的网络、超时与
 * 5xx 收敛为 KeycloakUnavailableError（→503）。以 fetch 桩模拟故障使
 * 用例不依赖宿主机是否允许监听 TCP 端口。
 */

function clientFor(timeoutMs = 5_000): OidcClient {
  return new OidcClient(
    parseAuthConfig({
      AUTH_SESSION_SECRET: 'unit-test-session-secret-0123456789abcdef',
      AUTH_REQUEST_TIMEOUT_MS: String(timeoutMs),
      KEYCLOAK_BASE_URL: 'http://keycloak.test',
      KEYCLOAK_REALM: 'rag-local',
    }),
  )
}

/** 结构合法、签名无效的 JWT；jose 会先经过 JWKS resolver，再校验签名。 */
const ID_TOKEN_REQUIRING_JWKS = [
  Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'test-key' })).toString('base64url'),
  Buffer.from(
    JSON.stringify({
      iss: 'http://keycloak.test/realms/rag-local',
      sub: 'kc-1',
      aud: 'rag-api',
      exp: Math.floor(Date.now() / 1000) + 600,
    }),
  ).toString('base64url'),
  'invalid-signature',
].join('.')

function tokenResponse(status: number, body = ''): Response {
  return new Response(body, { status })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('OidcClient：身份服务不可用与恢复', () => {
  it('token 端点网络故障时收敛为 KeycloakUnavailableError（映射 503）', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('ECONNREFUSED'))
    vi.stubGlobal('fetch', fetchMock)

    await expect(clientFor().exchangeCode('code', 'verifier')).rejects.toBeInstanceOf(
      KeycloakUnavailableError,
    )
  })

  it('token 端点恢复后，同一客户端实例可立即重试成功', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('ECONNREFUSED'))
      .mockResolvedValueOnce(
        tokenResponse(200, JSON.stringify({ id_token: 'stub', access_token: 'stub' })),
      )
    vi.stubGlobal('fetch', fetchMock)
    const client = clientFor()

    await expect(client.exchangeCode('code', 'verifier')).rejects.toBeInstanceOf(
      KeycloakUnavailableError,
    )
    await expect(client.exchangeCode('code', 'verifier')).resolves.toEqual({
      idToken: 'stub',
      accessToken: 'stub',
    })
  })

  it('token 端点 HTTP 5xx 映射为 KeycloakUnavailableError（503）', async () => {
    const fetchMock = vi.fn().mockResolvedValue(tokenResponse(503, 'temporarily unavailable'))
    vi.stubGlobal('fetch', fetchMock)

    await expect(clientFor().exchangeCode('code', 'verifier')).rejects.toBeInstanceOf(
      KeycloakUnavailableError,
    )
  })

  it('token 端点可达但拒绝请求（HTTP 400）时抛普通错误，不是依赖不可用', async () => {
    const fetchMock = vi.fn().mockResolvedValue(tokenResponse(400, '{"error":"invalid_grant"}'))
    vi.stubGlobal('fetch', fetchMock)

    await expect(clientFor().exchangeCode('code', 'verifier')).rejects.toThrow(/token 端点拒绝/)
  })

  it('JWKS 网络故障与 HTTP 5xx 均映射为 KeycloakUnavailableError（503）', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('ECONNREFUSED'))
      .mockResolvedValueOnce(tokenResponse(503, 'temporarily unavailable'))
    vi.stubGlobal('fetch', fetchMock)

    await expect(clientFor().verifyIdToken(ID_TOKEN_REQUIRING_JWKS)).rejects.toBeInstanceOf(
      KeycloakUnavailableError,
    )
    await expect(clientFor().verifyIdToken(ID_TOKEN_REQUIRING_JWKS)).rejects.toBeInstanceOf(
      KeycloakUnavailableError,
    )
  })

  it('JWKS 请求使用 AUTH_REQUEST_TIMEOUT_MS，而不等待 fetch 默认超时', async () => {
    let signal: AbortSignal | undefined
    const fetchMock = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          signal = init.signal ?? undefined
          signal?.addEventListener('abort', () => reject(signal?.reason), { once: true })
        }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await expect(clientFor(10).verifyIdToken(ID_TOKEN_REQUIRING_JWKS)).rejects.toBeInstanceOf(
      KeycloakUnavailableError,
    )
    expect(signal?.aborted).toBe(true)
  }, 1_000)
})
