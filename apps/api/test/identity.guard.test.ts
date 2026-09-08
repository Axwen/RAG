import { describe, expect, it } from 'vitest'
import type { Request } from 'express'
import type { ServerIdentityContext } from '@rag/contracts'
import { parseAuthConfig } from '../src/auth/auth.config'
import { IdentityGuard, identityOf } from '../src/auth/identity.guard'
import { signSession } from '../src/auth/session-cookie'
import { ingestionManifestCreateSchema } from '../src/manifests/manifests.schemas'

/**
 * IdentityGuard 与 tenantId 退场的 DoD 钉子（T14b）。
 *
 * 两条 DoD 在这里钉住：①请求体携带 tenantId 不生效（zod strip 后创建
 * 用的租户来自服务端身份）；②无有效会话的请求统一 401 信封。
 * 跨租户 id → NOT_FOUND 的钉子在 manifests.service.test.ts（服务层
 * 谓词）与集成层（真实 HTTP）。
 */

const config = parseAuthConfig({
  AUTH_SESSION_SECRET: 'unit-test-session-secret-0123456789abcdef',
  KEYCLOAK_BASE_URL: 'http://localhost:8080',
  KEYCLOAK_REALM: 'rag-local',
})

const TENANT_A = '018f0000-0000-7000-8000-000000000001'
const TENANT_B = '018f0000-0000-7000-8000-000000000099'

function contextWithTenants(...tenantIds: string[]): ServerIdentityContext {
  return {
    businessUserId: 'u1',
    issuer: config.issuer,
    subject: 'kc-1',
    displayName: 'Dev User',
    email: null,
    userStatus: 'ACTIVE',
    tenantMemberships: tenantIds.map((tenantId) => ({
      tenantId,
      status: 'ACTIVE' as const,
      tenantRole: null,
    })),
    workspaceMemberships: [],
  }
}

function requestWithCookie(cookie: string | undefined): Request {
  return { headers: cookie === undefined ? {} : { cookie } } as unknown as Request
}

function executionContextOf(request: Request): {
  switchToHttp: () => { getRequest: () => Request }
} {
  return { switchToHttp: () => ({ getRequest: () => request }) }
}

const guard = new IdentityGuard(config)

function sessionCookie(context: ServerIdentityContext): string {
  return `rag_session=${signSession({ context, expiresAt: Math.floor(Date.now() / 1000) + 60 }, config.sessionSecret)}`
}

describe('IdentityGuard', () => {
  it('单一 ACTIVE 租户成员 → 推导出租户并挂到请求', () => {
    const request = requestWithCookie(sessionCookie(contextWithTenants(TENANT_A)))
    expect(guard.canActivate(executionContextOf(request) as never)).toBe(true)
    expect(identityOf(request)).toMatchObject({ tenantId: TENANT_A })
    expect(identityOf(request).context.businessUserId).toBe('u1')
  })

  it('无会话/过期/伪造 cookie → 401 UNAUTHORIZED 信封', () => {
    for (const cookie of [undefined, 'rag_session=tampered.value', 'rag_session=']) {
      const request = requestWithCookie(cookie)
      expectApiError(() => guard.canActivate(executionContextOf(request) as never), 'UNAUTHORIZED')
    }
  })

  it('零个 ACTIVE 成员 → FORBIDDEN（身份已验证但不属于任何租户）', () => {
    const context = contextWithTenants(TENANT_A)
    const revoked: ServerIdentityContext = {
      ...context,
      tenantMemberships: [{ ...context.tenantMemberships[0]!, status: 'REVOKED' }],
    }
    const request = requestWithCookie(sessionCookie(revoked))
    expectApiError(() => guard.canActivate(executionContextOf(request) as never), 'FORBIDDEN')
  })

  it('多个 ACTIVE 租户 → FORBIDDEN（多租户切换未开放，不静默选第一个）', () => {
    const request = requestWithCookie(sessionCookie(contextWithTenants(TENANT_A, TENANT_B)))
    expectApiError(() => guard.canActivate(executionContextOf(request) as never), 'FORBIDDEN')
  })
})

describe('tenantId 退场（T14 DoD 迁移期兼容退场）', () => {
  it('请求体携带 tenantId 被忽略：schema strip 后不含该键', () => {
    const parsed = ingestionManifestCreateSchema.parse({
      tenantId: TENANT_B, // 试图声明别的租户
      version: 1,
      parserRef: 'deepdoc@1.0.0',
      chunkerRef: 'wide-1024@1.0.0',
      embeddingRef: 'bge-m3@1.0.0',
      indexSchemaRef: 'index-schema@1',
      sourceFormats: ['pdf'],
    })
    expect(parsed).not.toHaveProperty('tenantId')
    // 控制器随后用 identityOf(req).tenantId（服务端推导）调用服务——
    // 请求体里的 TENANT_B 全程无路可走。
  })
})

/** 断言抛出的是目标错误码的信封异常（普通函数，不用自定义 matcher——那需要扩充 vitest 类型）。 */
function expectApiError(fn: () => unknown, code: string): void {
  try {
    fn()
  } catch (error) {
    const envelope = (error as { envelope?: { code: string } }).envelope
    if (envelope?.code === code) return
    throw new Error(`预期错误码 ${code}，实际 ${(error as Error).message}`, { cause: error })
  }
  throw new Error(`预期抛出 ${code}，实际正常返回`)
}
