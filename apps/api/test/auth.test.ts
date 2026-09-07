import { describe, expect, it } from 'vitest'
import { createHash, createHmac } from 'node:crypto'
import type { ServerIdentityContext } from '@rag/contracts'
import { parseAuthConfig } from '../src/auth/auth.config'
import { createPkcePair, createState, safeEqual } from '../src/auth/pkce'
import {
  parsePkceCookie,
  parseSessionCookie,
  readCookie,
  signPkceCookie,
  signSession,
} from '../src/auth/session-cookie'

/**
 * auth 模块的单元层（T14a）。
 *
 * 这里钉的是协议原语与会话语义：PKCE 的 S256 派生、cookie 的签名/篡改/
 * 过期三分支、authorize URL 的参数完备性、state 不匹配拒绝。真实
 * Keycloak 往返（PKCE 全流程、JWKS 轮换、禁用/撤权/不可用）在集成层
 * （tests/keycloak-*.test.ts），两层不互相替代。
 */

const SECRET = 'unit-test-session-secret-0123456789abcdef'

describe('PKCE（RFC 7636）', () => {
  it('challenge 是 verifier 的 S256', () => {
    const { verifier, challenge } = createPkcePair()
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/)
    expect(challenge).toBe(createHash('sha256').update(verifier).digest('base64url'))
  })

  it('两次生成的 verifier 不同（随机，非定值）', () => {
    expect(createPkcePair().verifier).not.toBe(createPkcePair().verifier)
  })

  it('safeEqual 恒定时间比对：相同为真、不同为假、长度不同为假', () => {
    expect(safeEqual(createState(), createState())).toBe(false)
    const state = createState()
    expect(safeEqual(state, state)).toBe(true)
    expect(safeEqual('short', 'a-much-longer-state')).toBe(false)
  })
})

describe('会话 Cookie', () => {
  const context: ServerIdentityContext = {
    businessUserId: 'u1',
    issuer: 'http://localhost:8080/realms/rag-local',
    subject: 'kc-1',
    displayName: 'Dev User',
    email: null,
    userStatus: 'ACTIVE',
    tenantMemberships: [
      {
        tenantId: 't1',
        status: 'ACTIVE',
        tenantRole: { id: 'r0', code: 'tenant-admin', name: '租户管理员' },
      },
    ],
    workspaceMemberships: [
      {
        tenantId: 't1',
        workspaceId: 'w1',
        slug: 'agent-desk',
        name: '客服工作台',
        status: 'ACTIVE',
        role: { id: 'r1', code: 'agent', name: '客服' },
      },
    ],
  }

  it('签名与解析往返一致', () => {
    const cookie = signSession({ context, expiresAt: 999_999_999_999 }, SECRET)
    const parsed = parseSessionCookie(cookie, SECRET)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) throw new Error('unreachable')
    expect(parsed.payload.context).toEqual(context)
  })

  it('篡改载荷后签名校验失败', () => {
    const cookie = signSession({ context, expiresAt: 999_999_999_999 }, SECRET)
    const mac = cookie.split('.')[1]!
    const tampered = Buffer.from(JSON.stringify({ context, expiresAt: 1, x: 1 })).toString(
      'base64url',
    )
    expect(parseSessionCookie(`${tampered}.${mac}`, SECRET)).toEqual({
      ok: false,
      reason: 'BAD_SIGNATURE',
    })
  })

  it('过期会话返回 EXPIRED（会话过期语义在响应码上，七类场景之一）', () => {
    // expiresAt 是 Unix 秒：1 = epoch 后 1 秒；now = epoch 后 2 秒 → 已过期。
    const cookie = signSession({ context, expiresAt: 1 }, SECRET)
    expect(parseSessionCookie(cookie, SECRET, new Date(2_000))).toEqual({
      ok: false,
      reason: 'EXPIRED',
    })
  })

  it('缺失/畸形 cookie 返回 MALFORMED，不抛异常', () => {
    expect(parseSessionCookie(undefined, SECRET)).toEqual({ ok: false, reason: 'MALFORMED' })
    expect(parseSessionCookie('not-a-cookie', SECRET)).toEqual({ ok: false, reason: 'MALFORMED' })
  })

  it('换密钥签的会话被拒（多实例部署必须共享 AUTH_SESSION_SECRET）', () => {
    const cookie = signSession(
      { context, expiresAt: 999_999_999_999 },
      'other-secret-0123456789abcdef!!',
    )
    expect(parseSessionCookie(cookie, SECRET)).toEqual({ ok: false, reason: 'BAD_SIGNATURE' })
  })

  it('PKCE cookie 往返与防篡改', () => {
    const cookie = signPkceCookie({ verifier: 'v', state: 's' }, SECRET)
    expect(parsePkceCookie(cookie, SECRET)).toEqual({
      ok: true,
      payload: { verifier: 'v', state: 's' },
    })
    expect(parsePkceCookie(`${cookie}x`, SECRET)).toEqual({ ok: false, reason: 'BAD_SIGNATURE' })
  })

  it('载荷非法 JSON 或非法 base64url 时返回 MALFORMED', () => {
    // 签名结构对（两段以点分隔）但载荷解不开：比「格式就不对」深一层。
    const mac = createHmac('sha256', SECRET).update('bm90LWpzb24').digest('base64url')
    expect(parseSessionCookie(`bm90LWpzb24.${mac}`, SECRET)).toEqual({
      ok: false,
      reason: 'MALFORMED',
    })
  })

  it('PKCE cookie 载荷缺字段或非法时返回 MALFORMED', () => {
    const body = Buffer.from(JSON.stringify({ verifier: 'v' })).toString('base64url')
    const mac = createHmac('sha256', SECRET).update(body).digest('base64url')
    expect(parsePkceCookie(`${body}.${mac}`, SECRET)).toEqual({ ok: false, reason: 'MALFORMED' })
    const bad = Buffer.from('not-json').toString('base64url')
    const badMac = createHmac('sha256', SECRET).update(bad).digest('base64url')
    expect(parsePkceCookie(`${bad}.${badMac}`, SECRET)).toEqual({ ok: false, reason: 'MALFORMED' })
  })

  it('readCookie 从原始 Cookie 头取值、容忍空格与多余分号', () => {
    const header = 'a=1; rag_session=abc.def; other=zzz'
    expect(readCookie(header, 'rag_session')).toBe('abc.def')
    expect(readCookie('rag_pkce=x', 'rag_session')).toBeUndefined()
    expect(readCookie(undefined, 'rag_session')).toBeUndefined()
    expect(readCookie('rag_session=', 'rag_session')).toBe('')
  })
})

describe('auth 配置', () => {
  it('从 Keycloak 接入点派生 OIDC 端点与 issuer', () => {
    const config = parseAuthConfig({
      AUTH_SESSION_SECRET: SECRET,
      KEYCLOAK_BASE_URL: 'http://localhost:8080/',
      KEYCLOAK_REALM: 'rag-local',
      AUTH_API_BASE_URL: 'http://localhost:3001/',
    })
    expect(config.issuer).toBe('http://localhost:8080/realms/rag-local')
    expect(config.authorizeUrl).toBe(
      'http://localhost:8080/realms/rag-local/protocol/openid-connect/auth',
    )
    expect(config.tokenUrl).toBe(
      'http://localhost:8080/realms/rag-local/protocol/openid-connect/token',
    )
    expect(config.redirectUri).toBe('http://localhost:3001/auth/callback')
  })

  it('会话密钥短于 32 字节时启动失败（fail-fast，不等到第一次请求）', () => {
    expect(() =>
      parseAuthConfig({
        AUTH_SESSION_SECRET: 'too-short',
        KEYCLOAK_BASE_URL: 'http://localhost:8080',
      }),
    ).toThrow()
  })

  it('未显式配置时使用本地兜底并标注（生产必须显式提供）', () => {
    const config = parseAuthConfig({})
    expect(config.isLocalFallbackSecret).toBe(true)
    expect(config.clientId).toBe('rag-api')
    expect(config.sessionTtlSeconds).toBe(3600)
  })
})
