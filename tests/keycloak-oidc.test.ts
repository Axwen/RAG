import { createHash, randomBytes } from 'node:crypto'
import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { createRemoteJWKSet, jwtVerify } from 'jose'

/**
 * Keycloak 容器集成（T14a 七类场景里的五类，真实 realm 往返）。
 *
 * 跑这一层的前提：`pnpm run infra:up` + `bash infra/compose/init/init-keycloak.sh`
 * 已在本地执行（dev 用户、rag-api 客户端就绪）。它不在 CI 上跑（AGENTS.md
 * 纪律 6：真实容器调用只在本地），CI 覆盖的是单元层。
 *
 * 五类在这里：PKCE 全流程、JWKS 轮换、token 过期、用户禁用（+恢复）、
 * 撤权。剩下两类（身份服务不可用、恢复）不需要真实 Keycloak——那是
 * OidcClient 收敛网络错误的行为，在 apps/api/test/oidc-client.test.ts
 * 用本地桩服务器钉住，不用起停共享容器来演戏。
 *
 * Authorization Code 没有浏览器，就走 Keycloak 的登录表单：GET authorize
 * URL → 解析 form action → POST 凭据 → 302 带 code。这和浏览器做的
 * 是同一组 HTTP 往返，验证的是协议而不是页面。
 */

const baseUrl = (process.env['KEYCLOAK_BASE_URL'] ?? 'http://localhost:8080').replace(
  /\/+$/,
  '',
)
const realm = process.env['KEYCLOAK_REALM'] ?? 'rag-local'
const issuer = `${baseUrl}/realms/${realm}`
const adminUser = process.env['KEYCLOAK_ADMIN'] ?? 'admin'
const adminPassword = process.env['KEYCLOAK_ADMIN_PASSWORD']
const devPassword = process.env['DEV_USER_PASSWORD']
const clientId = 'rag-api'
const redirectUri = 'http://localhost:3001/auth/callback'

const requireEnv = (name: string, value: string | undefined): string => {
  if (value === undefined || value === '') {
    throw new Error(`集成测试需要 ${name}（.env 提供；先跑 init-keycloak.sh）`)
  }
  return value
}

interface AdminToken {
  token: string
  getUserId: (username: string) => Promise<string>
  disableUser: (id: string) => Promise<void>
  enableUser: (id: string) => Promise<void>
  setAccessTokenLifespan: (seconds: number) => Promise<void>
  addGeneratedRsaKey: (name: string) => Promise<void>
  removeComponent: (name: string) => Promise<void>
}

async function adminApi(): Promise<AdminToken> {
  const response = await fetch(`${baseUrl}/realms/master/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'password',
      client_id: 'admin-cli',
      username: adminUser,
      password: requireEnv('KEYCLOAK_ADMIN_PASSWORD', adminPassword),
    }),
  })
  if (!response.ok) throw new Error(`Keycloak 管理令牌获取失败：HTTP ${response.status}`)
  const { access_token: token } = (await response.json()) as { access_token: string }
  const auth = { authorization: `Bearer ${token}` }
  const api = `${baseUrl}/admin/realms/${realm}`

  const getUserId = async (username: string): Promise<string> => {
    const found = await fetch(`${api}/users?username=${username}&exact=true`, { headers: auth })
    const users = (await found.json()) as ReadonlyArray<{ id: string }>
    if (users.length !== 1) throw new Error(`realm 用户 ${username} 不唯一或不存在`)
    return users[0]!.id
  }

  return {
    token,
    getUserId,
    disableUser: async (id) => {
      const res = await fetch(`${api}/users/${id}`, {
        method: 'PUT',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: false }),
      })
      expect(res.ok).toBe(true)
    },
    enableUser: async (id) => {
      const res = await fetch(`${api}/users/${id}`, {
        method: 'PUT',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: true }),
      })
      expect(res.ok).toBe(true)
    },
    setAccessTokenLifespan: async (seconds) => {
      // 读-改-写整个 realm 表示：PATCH 不被 Admin API 接受。
      const current = await (await fetch(`${api}`, { headers: auth })).json()
      const res = await fetch(`${api}`, {
        method: 'PUT',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ ...current, accessTokenLifespan: seconds }),
      })
      expect(res.ok).toBe(true)
    },
    addGeneratedRsaKey: async (name) => {
      // 轮换的实现方式：新增更高优先级的 rsa-generated key provider，
      // 新 token 用新 kid 签名，JWKS 同时列出两把——这正是轮换后的形态。
      // parentId 必须是 realm 的**内部 id**（UUID），不是 realm 名：这个
      // realm 由 Admin API 创建，内部 id 与名字不一致；给错爹的组件会被
      // 静默接受（201）但密钥永远不进 realm 的密钥集。
      const realmId = ((await (
        await fetch(`${api}`, { headers: auth })
      ).json()) as { id: string }).id
      const res = await fetch(`${api}/components`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({
          name,
          providerId: 'rsa-generated',
          providerType: 'org.keycloak.keys.KeyProvider',
          parentId: realmId,
          config: { priority: ['300'] },
        }),
      })
      expect(res.ok).toBe(true)
    },
    removeComponent: async (name) => {
      const found = await fetch(`${api}/components?name=${name}`, { headers: auth })
      const components = (await found.json()) as ReadonlyArray<{ id: string }>
      for (const component of components) {
        const res = await fetch(`${api}/components/${component.id}`, {
          method: 'DELETE',
          headers: auth,
        })
        expect(res.ok).toBe(true)
      }
    },
  }
}

/** 走登录表单完成 Authorization Code + PKCE，返回授权码。 */
async function authorizeWithPkce(username: string, password: string): Promise<{
  code: string
  verifier: string
}> {
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  const authorizeUrl = new URL(`${issuer}/protocol/openid-connect/auth`)
  authorizeUrl.searchParams.set('client_id', clientId)
  authorizeUrl.searchParams.set('redirect_uri', redirectUri)
  authorizeUrl.searchParams.set('response_type', 'code')
  authorizeUrl.searchParams.set('scope', 'openid profile email')
  authorizeUrl.searchParams.set('code_challenge', challenge)
  authorizeUrl.searchParams.set('code_challenge_method', 'S256')

  const loginPage = await fetch(authorizeUrl, { redirect: 'manual' })
  const html = await loginPage.text()
  // 授权会话 cookie 必须随表单 POST 回去：AUTH_SESSION_ID 把这次登录和
  // authorize 请求的客户端状态绑在一起，丢了它 Keycloak 直接拒绝提交。
  const cookies = loginPage.headers
    .getSetCookie()
    .map((cookie) => cookie.split(';')[0])
    .join('; ')
  // Keycloak 登录表单的 action 是完整 URL，含继续授权所需的 session_code。
  const action = /action="([^"]+)"/.exec(html)?.[1]
  if (action === undefined) throw new Error('登录页解析失败：找不到 form action')
  const form = new URLSearchParams({ username, password, credentialId: '' })
  const post = await fetch(action.replace(/&amp;/g, '&'), {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      cookie: cookies,
    },
    body: form,
    redirect: 'manual',
  })
  const location = post.headers.get('location') ?? ''
  const code = new URL(location).searchParams.get('code')
  if (code === null) {
    throw new Error(`授权码获取失败：status=${post.status} location=${location.slice(0, 120)}`)
  }
  return { code, verifier }
}

async function exchangeCode(code: string, verifier: string): Promise<{
  idToken: string
  refreshToken: string
}> {
  const response = await fetch(`${issuer}/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: clientId,
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    }),
  })
  if (!response.ok) {
    throw new Error(`token 交换失败：HTTP ${response.status} ${await response.text()}`)
  }
  const json = (await response.json()) as { id_token: string; refresh_token: string }
  return { idToken: json.id_token, refreshToken: json.refresh_token }
}

describe('Keycloak OIDC 集成（T14a 七类场景之五）', () => {
  let admin: AdminToken
  let devUserId: string
  let originalLifespan: number
  const devUsername = process.env['DEV_USER_NAME'] ?? 'dev'
  const keyName = `t14a-rotation-test-${Date.now()}`

  beforeAll(async () => {
    admin = await adminApi()
    devUserId = await admin.getUserId(devUsername)
    const realmRep = (await (
      await fetch(`${baseUrl}/admin/realms/${realm}`, {
        headers: { authorization: `Bearer ${admin.token}` },
      })
    ).json()) as { accessTokenLifespan: number }
    originalLifespan = realmRep.accessTokenLifespan
  })

  afterAll(async () => {
    // realm 状态还原：lifespan、key provider、用户启用。
    await admin.setAccessTokenLifespan(originalLifespan)
    await admin.removeComponent(keyName)
    await admin.enableUser(devUserId)
  })

  it('PKCE 全流程：表单登录 → code → token，ID token 经 JWKS 验签且 iss/sub 稳定', async () => {
    const { code, verifier } = await authorizeWithPkce(
      devUsername,
      requireEnv('DEV_USER_PASSWORD', devPassword),
    )
    const { idToken } = await exchangeCode(code, verifier)
    const jwks = createRemoteJWKSet(new URL(`${issuer}/protocol/openid-connect/certs`))
    const verified = await jwtVerify(idToken, jwks, {
      issuer,
      audience: clientId,
    })
    expect(verified.payload.iss).toBe(issuer)
    // sub 是 Keycloak 用户 id；种子库的 BusinessUser.subject 与它同源对齐。
    expect(verified.payload.sub).toBe(devUserId)
  })

  it('错误 verifier 换不到 token（PKCE 是客户端证明，拦截 code 无用）', async () => {
    const { code } = await authorizeWithPkce(
      devUsername,
      requireEnv('DEV_USER_PASSWORD', devPassword),
    )
    const response = await fetch(`${issuer}/protocol/openid-connect/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: clientId,
        code,
        redirect_uri: redirectUri,
        code_verifier: randomBytes(32).toString('base64url'),
      }),
    })
    expect(response.status).toBe(400)
  })

  it('JWKS 轮换：新增高优先级密钥后，同一 JWKS 客户端自动重取并验签新 token', async () => {
    // kid 在 JWT 第一段（header）；payload 里没有它。
    const kidOf = (idToken: string): string =>
      (JSON.parse(Buffer.from(idToken.split('.')[0]!, 'base64url').toString()) as {
        kid: string
      }).kid

    // 先取一把旧 token，建 JWKS 客户端（缓存初始密钥集）。
    const before = await authorizeWithPkce(
      devUsername,
      requireEnv('DEV_USER_PASSWORD', devPassword),
    )
    const beforeTokens = await exchangeCode(before.code, before.verifier)
    const jwks = createRemoteJWKSet(new URL(`${issuer}/protocol/openid-connect/certs`))
    const beforeKid = kidOf(beforeTokens.idToken)

    await admin.addGeneratedRsaKey(keyName)

    const after = await authorizeWithPkce(
      devUsername,
      requireEnv('DEV_USER_PASSWORD', devPassword),
    )
    const afterTokens = await exchangeCode(after.code, after.verifier)
    const afterKid = kidOf(afterTokens.idToken)

    // 新 token 确实换了密钥；同一个（已缓存旧密钥集的）客户端仍然验签成功——
    // jose 在未知 kid 上自动重取 JWKS，这正是 OidcClient 依赖的轮换行为。
    expect(afterKid).not.toBe(beforeKid)
    await expect(
      jwtVerify(afterTokens.idToken, jwks, { issuer, audience: clientId }),
    ).resolves.toBeTruthy()
  })

  it('token 过期：accessTokenLifespan=1s 后 token 不可用', async () => {
    await admin.setAccessTokenLifespan(1)
    const { code, verifier } = await authorizeWithPkce(
      devUsername,
      requireEnv('DEV_USER_PASSWORD', devPassword),
    )
    const { idToken } = await exchangeCode(code, verifier)
    await new Promise((resolve) => setTimeout(resolve, 2_500))
    const jwks = createRemoteJWKSet(new URL(`${issuer}/protocol/openid-connect/certs`))
    await expect(
      jwtVerify(idToken, jwks, { issuer, audience: clientId }),
    ).rejects.toThrow(/exp/)
  })

  it('用户禁用：refresh 被拒；恢复启用后可重新登录', async () => {
    const first = await authorizeWithPkce(
      devUsername,
      requireEnv('DEV_USER_PASSWORD', devPassword),
    )
    const { refreshToken } = await exchangeCode(first.code, first.verifier)

    await admin.disableUser(devUserId)
    const refreshWhileDisabled = await fetch(`${issuer}/protocol/openid-connect/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: clientId,
        refresh_token: refreshToken,
      }),
    })
    // PROBE-001 的口径：禁用后 refresh 400，而不是静默成功。
    expect(refreshWhileDisabled.status).toBe(400)

    await admin.enableUser(devUserId)
    const recovered = await authorizeWithPkce(
      devUsername,
      requireEnv('DEV_USER_PASSWORD', devPassword),
    )
    const recoveredTokens = await exchangeCode(recovered.code, recovered.verifier)
    const jwks = createRemoteJWKSet(new URL(`${issuer}/protocol/openid-connect/certs`))
    await expect(
      jwtVerify(recoveredTokens.idToken, jwks, { issuer, audience: clientId }),
    ).resolves.toBeTruthy()
  })

  it('撤权：revocation 端点吊销 refresh token 后不可再刷新', async () => {
    const { code, verifier } = await authorizeWithPkce(
      devUsername,
      requireEnv('DEV_USER_PASSWORD', devPassword),
    )
    const { refreshToken } = await exchangeCode(code, verifier)

    const revoke = await fetch(`${issuer}/protocol/openid-connect/revoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        token: refreshToken,
        token_type_hint: 'refresh_token',
      }),
    })
    expect(revoke.ok).toBe(true)

    const refreshAfterRevoke = await fetch(`${issuer}/protocol/openid-connect/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: clientId,
        refresh_token: refreshToken,
      }),
    })
    expect(refreshAfterRevoke.status).toBe(400)
  })
})
