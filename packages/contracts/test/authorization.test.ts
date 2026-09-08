import { describe, expect, it } from 'vitest'
import {
  parseScopeKey,
  scopeKeyForKnowledgeSpace,
  type AuthorizationDecision,
} from '../src/auth/authorization'
import { REASON_CODES, categoryForReasonCode } from '../src/audit/reason-codes'

/**
 * 授权契约（T14b / ADR-0026、ADR-0039）。
 *
 * 作用域键是索引侧（T5 投影）与查询侧（T6 编译）的共用协议：格式一旦
 * 发布就有历史数据压在上面，这里把「生成↔解析互逆」与「非法键不匹配」
 * 钉住。授权原因码与审计注册表的对应关系也在这里钉——两处漂移会让
 * 审计行写出调用方根本不会返回的拒绝原因。
 */

const TENANT = '018f0000-0000-7000-8000-000000000001'
const SPACE = '018f0000-0000-7000-8000-000000000010'

describe('acl_scope_key', () => {
  it('生成与解析互逆', () => {
    const key = scopeKeyForKnowledgeSpace(TENANT, SPACE)
    expect(key).toBe(`t:${TENANT}:ks:${SPACE}`)
    expect(parseScopeKey(key)).toEqual({ tenantId: TENANT, knowledgeSpaceId: SPACE })
  })

  it('非本格式的键返回 undefined，不抛异常', () => {
    expect(parseScopeKey('not-a-scope-key')).toBeUndefined()
    expect(parseScopeKey('t:not-uuid:ks:x')).toBeUndefined()
    expect(parseScopeKey(`t:${TENANT}:ks:${SPACE}:extra`)).toBeUndefined()
    expect(parseScopeKey('')).toBeUndefined()
  })

  it('租户不同的键解析出不同租户（过滤键的隔离性）', () => {
    const other = scopeKeyForKnowledgeSpace('018f0000-0000-7000-8000-000000000099', SPACE)
    expect(parseScopeKey(other)?.tenantId).not.toBe(TENANT)
  })
})

describe('授权决策与审计原因码的对应', () => {
  it('三类拒绝原因各对应一个已注册的 authz 码', () => {
    const denialToCode: Record<string, string> = {
      CAPABILITY_MISSING: 'authz.capability_denied',
      SCOPE_DENIED: 'authz.scope_denied',
      DEPENDENCY_UNAVAILABLE: 'authz.dependency_unavailable',
    }
    for (const code of Object.values(denialToCode)) {
      expect(REASON_CODES[code as keyof typeof REASON_CODES]).toBe('AUTHZ')
    }
    // 允许也有码：统一授权入口每次判定都写审计（T14 DoD）。
    expect(REASON_CODES['authz.capability_allowed']).toBe('AUTHZ')
  })

  it('决策形状：允许无载荷、拒绝必带原因', () => {
    const allowed: AuthorizationDecision = { allowed: true }
    const denied: AuthorizationDecision = { allowed: false, reason: 'SCOPE_DENIED' }
    expect('reason' in allowed).toBe(false)
    expect(denied).toMatchObject({ reason: 'SCOPE_DENIED' })
  })

  it('categoryForReasonCode 对新码派生 AUTHZ', () => {
    expect(categoryForReasonCode('authz.scope_denied')).toBe('AUTHZ')
    expect(categoryForReasonCode('authz.dependency_unavailable')).toBe('AUTHZ')
  })
})
