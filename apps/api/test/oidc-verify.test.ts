import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import { parseAuthConfig } from '../src/auth/auth.config'
import { OidcClient } from '../src/auth/oidc-client'

/**
 * verifyIdToken 的单元层（T14a）。
 *
 * JWKS 不指向真实 Keycloak，而是由 fetch 桩按 JWKS 格式回测试生成的公钥。
 * 这一层钉的是校验规则本身：iss 必须等于配置的 issuer、aud 必须是本客户端、
 * exp 过了就拒。真实 realm 的签名与轮换行为在 tests/keycloak-oidc.test.ts。
 */

const BASE_URL = 'http://keycloak.test'
const ISSUER = `${BASE_URL}/realms/rag-local`
const AUDIENCE = 'rag-api'

/** 密钥对与桩服务器在 beforeAll 里建：CJS 测试文件不允许顶层 await。 */
let privateKey: CryptoKey

beforeAll(async () => {
  const pair = await generateKeyPair('RS256')
  privateKey = pair.privateKey
  const jwk = await exportJWK(pair.publicKey)
  const jwksBody = JSON.stringify({ keys: [{ ...jwk, kid: 'test-key', use: 'sig', alg: 'RS256' }] })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL) => {
      if (String(url).includes('/protocol/openid-connect/certs')) {
        return new Response(jwksBody, {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response(null, { status: 404 })
    }),
  )
})
afterAll(() => {
  vi.unstubAllGlobals()
})

const config = parseAuthConfig({
  AUTH_SESSION_SECRET: 'unit-test-session-secret-0123456789abcdef',
  AUTH_REQUEST_TIMEOUT_MS: '5000',
  KEYCLOAK_BASE_URL: BASE_URL,
  KEYCLOAK_REALM: 'rag-local',
})

const client = new OidcClient(config)

async function signIdToken(claims: {
  iss?: string
  sub?: string
  aud?: string
  exp?: string | number
}): Promise<string> {
  return new SignJWT({ sub: claims.sub ?? 'kc-1' })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setIssuer(claims.iss ?? ISSUER)
    .setAudience(claims.aud ?? AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(claims.exp ?? '10m')
    .sign(privateKey)
}

describe('OidcClient.verifyIdToken', () => {
  it('签名与 iss/sub/aud 全部匹配时返回 claims', async () => {
    const claims = await client.verifyIdToken(await signIdToken({}))
    expect(claims).toEqual({ issuer: ISSUER, subject: 'kc-1' })
  })

  it('issuer 不匹配时拒绝', async () => {
    await expect(
      client.verifyIdToken(await signIdToken({ iss: 'http://other/realms/x' })),
    ).rejects.toThrow(/ID token 校验失败/)
  })

  it('audience 不是本客户端时拒绝', async () => {
    await expect(client.verifyIdToken(await signIdToken({ aud: 'other-client' }))).rejects.toThrow(
      /ID token 校验失败/,
    )
  })

  it('过期 token 拒绝（401 语义，不是 503）', async () => {
    await expect(client.verifyIdToken(await signIdToken({ exp: 1 }))).rejects.toThrow(
      /ID token 校验失败/,
    )
  })
})
