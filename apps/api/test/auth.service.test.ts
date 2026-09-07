import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ServerIdentityContext } from '@rag/contracts'
import { loadIdentityContext } from '@rag/database'
import { parseAuthConfig } from '../src/auth/auth.config'
import { AuthService } from '../src/auth/auth.service'
import { KeycloakUnavailableError, type OidcClient } from '../src/auth/oidc-client'

/**
 * AuthService 的编排逻辑（T14a）。
 *
 * OidcClient 与 Prisma/loadIdentityContext 都是外部边界，在这里替换成桩：
 * 这一层钉的是 state 校验、claims 透传、身份映射分支与 Keycloak 不可用的
 * 传播。token 交换与 JWKS 校验的真实行为在集成层（tests/）。
 */

vi.mock('@rag/database', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, loadIdentityContext: vi.fn() }
})

const config = parseAuthConfig({
  AUTH_SESSION_SECRET: 'unit-test-session-secret-0123456789abcdef',
  KEYCLOAK_BASE_URL: 'http://localhost:8080',
  KEYCLOAK_REALM: 'rag-local',
})

const context: ServerIdentityContext = {
  businessUserId: 'u1',
  issuer: config.issuer,
  subject: 'kc-1',
  displayName: 'Dev User',
  email: null,
  userStatus: 'ACTIVE',
  tenantMemberships: [],
  workspaceMemberships: [],
}

const loadIdentityMock = vi.mocked(loadIdentityContext)

function makeService(oidc: Partial<OidcClient>): AuthService {
  const prisma = {
    // $transaction 只负责把 tx 传给回调；事务语义归集成层。
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({})),
  }
  const service = new AuthService(config, prisma as never)
  ;(service as unknown as { oidc: OidcClient }).oidc = {
    exchangeCode: vi.fn(async () => ({ idToken: 'id', accessToken: 'at' })),
    verifyIdToken: vi.fn(async () => ({ issuer: config.issuer, subject: 'kc-1' })),
    ...oidc,
  } as OidcClient
  return service
}

beforeEach(() => {
  loadIdentityMock.mockReset()
})

describe('AuthService.buildLoginRequest', () => {
  it('authorize URL 携带 PKCE 与 state 的全部参数', () => {
    const service = makeService({})
    const request = service.buildLoginRequest()
    const url = new URL(request.authorizeUrl)
    expect(url.pathname.endsWith('/protocol/openid-connect/auth')).toBe(true)
    expect(url.searchParams.get('client_id')).toBe('rag-api')
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(url.searchParams.get('state')).toBe(request.state)
    // challenge 是 verifier 的 S256，而 verifier 本身不进 URL。
    expect(url.searchParams.get('code_challenge')).not.toContain(request.verifier)
  })
})

describe('AuthService.sessionView', () => {
  it('返回契约的会话投影', () => {
    const service = makeService({})
    const view = service.sessionView(context)
    expect(view.businessUserId).toBe('u1')
    expect(view).not.toHaveProperty('issuer')
  })
})

describe('AuthService.establishIdentity', () => {
  it('state 不匹配时拒绝（CSRF 防线在进 Keycloak 之前）', async () => {
    const service = makeService({
      exchangeCode: vi.fn(async () => {
        throw new Error('不应触达 token 端点')
      }),
    })
    await expect(
      service.establishIdentity('code', 'verifier', 'expected', 'other'),
    ).rejects.toMatchObject({ name: 'InvalidStateException' })
    await expect(
      service.establishIdentity('code', 'verifier', undefined, 'other'),
    ).rejects.toMatchObject({ name: 'InvalidStateException' })
  })

  it('token 校验通过的 claims 原样传给身份装配', async () => {
    loadIdentityMock.mockResolvedValue({ ok: true, context })
    const service = makeService({})
    const result = await service.establishIdentity('code', 'verifier', 'st', 'st')
    expect(result).toEqual(context)
    expect(loadIdentityMock).toHaveBeenCalledWith(expect.anything(), {
      issuer: config.issuer,
      subject: 'kc-1',
    })
  })

  it('身份被拒（未建档/禁用）抛 IdentityRejectedError', async () => {
    loadIdentityMock.mockResolvedValue({ ok: false, reason: 'USER_DISABLED' })
    const service = makeService({})
    await expect(service.establishIdentity('code', 'verifier', 'st', 'st')).rejects.toMatchObject({
      name: 'IdentityRejectedError',
      reason: 'USER_DISABLED',
    })
  })

  it('Keycloak 不可用原样传播（由控制器映射 503）', async () => {
    const service = makeService({
      exchangeCode: vi.fn(async () => {
        throw new KeycloakUnavailableError(new Error('ECONNREFUSED'))
      }),
    })
    loadIdentityMock.mockResolvedValue({ ok: true, context })
    await expect(service.establishIdentity('code', 'verifier', 'st', 'st')).rejects.toBeInstanceOf(
      KeycloakUnavailableError,
    )
    // 不可用发生在身份装配之前。
    expect(loadIdentityMock).not.toHaveBeenCalled()
  })
})
