import { describe, expect, it } from 'vitest'
import type { ServerIdentityContext } from '@rag/contracts'
import { parseAuthConfig } from '../src/auth/auth.config'
import { AuthController } from '../src/auth/auth.controller'
import type { AuthService } from '../src/auth/auth.service'
import { IdentityRejectedError, InvalidStateException } from '../src/auth/auth.service'
import { KeycloakUnavailableError } from '../src/auth/oidc-client'
import {
  PKCE_COOKIE_NAME,
  SESSION_COOKIE_NAME,
  signPkceCookie,
  signSession,
} from '../src/auth/session-cookie'

/**
 * AuthController 的 HTTP 边界（T14a）。
 *
 * 这里钉的是「错误码映射 + cookie 设置」而不是 OIDC 协议（集成层）或
 * 编排逻辑（auth.service.test.ts）。Response 用最小桩：控制器只用
 * res.cookie/clearCookie/redirect/status/json 和 req.headers.cookie，
 * 桩到这个面就够，不起 NestJS 测试容器。
 */

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

interface Recorded {
  cookies: Array<{ name: string; value: string; options?: Record<string, unknown> }>
  cleared: string[]
  redirect?: { status: number; url: string }
  status?: number
  json?: unknown
}

/** 最小 Response 桩；initialCookie 会出现在 req.headers.cookie（回调读 PKCE 用）。 */
function fakeResponse(initialCookie?: string): {
  res: Record<string, unknown>
  recorded: Recorded
} {
  const recorded: Recorded = { cookies: [], cleared: [] }
  const res: Record<string, unknown> = {
    cookie(name: string, value: string, options?: Record<string, unknown>) {
      recorded.cookies.push(options === undefined ? { name, value } : { name, value, options })
    },
    clearCookie(name: string) {
      recorded.cleared.push(name)
    },
    redirect(status: number, url: string) {
      recorded.redirect = { status, url }
    },
    status(status: number) {
      recorded.status = status
      return res
    },
    json(body: unknown) {
      recorded.json = body
      return res
    },
  }
  res['req'] = {
    headers: initialCookie === undefined ? {} : { cookie: initialCookie },
  }
  return { res, recorded }
}

type Establish = (
  code: string,
  verifier: string,
  expected: string | undefined,
  received: string | undefined,
) => Promise<ServerIdentityContext>

function makeController(establish: Establish): AuthController {
  const service = {
    buildLoginRequest: () => ({ authorizeUrl: 'http://kc/auth', verifier: 'v', state: 'st' }),
    establishIdentity: establish,
    sessionView: (ctx: ServerIdentityContext) => ({ businessUserId: ctx.businessUserId }),
  } as unknown as AuthService
  return new AuthController(config, service)
}

function envelopeCode(error: unknown): string {
  const envelope = (error as { envelope?: { code: string } }).envelope
  if (envelope === undefined) throw new Error(`预期 ApiErrorException，实际 ${String(error)}`)
  return envelope.code
}

/** 同步路径：断言控制器抛出的是目标错误码的信封异常。 */
function expectApiError(fn: () => unknown, code: string): void {
  try {
    fn()
  } catch (error) {
    expect(envelopeCode(error)).toBe(code)
    return
  }
  throw new Error(`预期抛出 ${code}，实际正常返回`)
}

/** 异步路径同上。 */
async function expectApiErrorAsync(fn: () => Promise<unknown>, code: string): Promise<void> {
  try {
    await fn()
  } catch (error) {
    expect(envelopeCode(error)).toBe(code)
    return
  }
  throw new Error(`预期抛出 ${code}，实际正常返回`)
}

const pkceCookie = signPkceCookie({ verifier: 'v', state: 'st' }, config.sessionSecret)

describe('AuthController.login', () => {
  it('设置 httpOnly PKCE cookie 并 302 到 authorize URL', () => {
    const controller = makeController(async () => context)
    const { res, recorded } = fakeResponse()
    controller.login(res as never)
    expect(recorded.redirect).toMatchObject({ status: 302, url: 'http://kc/auth' })
    expect(recorded.cookies[0]?.name).toBe(PKCE_COOKIE_NAME)
    expect(recorded.cookies[0]?.options).toMatchObject({ httpOnly: true, sameSite: 'lax' })
  })
})

describe('AuthController.callback', () => {
  it('Keycloak 侧 error 参数映射 UNAUTHORIZED，不转发 IdP 文案', async () => {
    const controller = makeController(async () => context)
    const { res, recorded } = fakeResponse()
    await expectApiErrorAsync(
      () => controller.callback(undefined, 'st', 'access_denied', res as never),
      'UNAUTHORIZED',
    )
    expect(recorded.cleared).toContain(PKCE_COOKIE_NAME)
  })

  it('缺少授权码映射 VALIDATION_ERROR', async () => {
    const controller = makeController(async () => context)
    const { res } = fakeResponse()
    await expectApiErrorAsync(
      () => controller.callback(undefined, 'st', undefined, res as never),
      'VALIDATION_ERROR',
    )
  })

  it('没有 PKCE cookie（伪造/过期回调）映射 UNAUTHORIZED', async () => {
    const controller = makeController(async () => context)
    const { res } = fakeResponse()
    await expectApiErrorAsync(
      () => controller.callback('code', 'st', undefined, res as never),
      'UNAUTHORIZED',
    )
  })

  it('Keycloak 不可用映射 DEPENDENCY_UNAVAILABLE', async () => {
    const controller = makeController(async () => {
      throw new KeycloakUnavailableError(new Error('refused'))
    })
    const { res } = fakeResponse(`${PKCE_COOKIE_NAME}=${pkceCookie}`)
    await expectApiErrorAsync(
      () => controller.callback('code', 'st', undefined, res as never),
      'DEPENDENCY_UNAVAILABLE',
    )
  })

  it('state 不匹配与身份被拒映射 UNAUTHORIZED', async () => {
    const stateMismatch = makeController(async () => {
      throw new InvalidStateException()
    })
    const { res: resA } = fakeResponse(`${PKCE_COOKIE_NAME}=${pkceCookie}`)
    await expectApiErrorAsync(
      () => stateMismatch.callback('code', 'st', undefined, resA as never),
      'UNAUTHORIZED',
    )

    const rejected = makeController(async () => {
      throw new IdentityRejectedError('USER_DISABLED')
    })
    const { res: resB } = fakeResponse(`${PKCE_COOKIE_NAME}=${pkceCookie}`)
    await expectApiErrorAsync(
      () => rejected.callback('code', 'st', undefined, resB as never),
      'UNAUTHORIZED',
    )
  })

  it('成功时签发 httpOnly 会话 cookie 并返回会话视图', async () => {
    const controller = makeController(async () => context)
    const { res, recorded } = fakeResponse(`${PKCE_COOKIE_NAME}=${pkceCookie}`)
    await controller.callback('code', 'st', undefined, res as never)
    const session = recorded.cookies.find((c) => c.name === SESSION_COOKIE_NAME)
    expect(session).toBeDefined()
    expect(session?.options).toMatchObject({ httpOnly: true, sameSite: 'lax', path: '/' })
    expect(recorded.status).toBe(200)
    expect(recorded.json).toMatchObject({ businessUserId: 'u1' })
  })
})

describe('AuthController.session / logout', () => {
  it('无会话 cookie 映射 UNAUTHORIZED', () => {
    const controller = makeController(async () => context)
    const { res } = fakeResponse()
    expectApiError(() => controller.session({ headers: {} } as never, res as never), 'UNAUTHORIZED')
  })

  it('有效会话返回投影', () => {
    const controller = makeController(async () => context)
    const { res, recorded } = fakeResponse()
    const cookie = signSession(
      { context, expiresAt: Math.floor(Date.now() / 1000) + 60 },
      config.sessionSecret,
    )
    controller.session(
      { headers: { cookie: `${SESSION_COOKIE_NAME}=${cookie}` } } as never,
      res as never,
    )
    expect(recorded.json).toMatchObject({ businessUserId: 'u1' })
  })

  it('logout 清除会话 cookie', () => {
    const controller = makeController(async () => context)
    const { res, recorded } = fakeResponse()
    controller.logout(res as never)
    expect(recorded.cleared).toContain(SESSION_COOKIE_NAME)
    expect(recorded.json).toEqual({ status: 'ok' })
  })
})
