import { describe, expect, it } from 'vitest'
import {
  REASON_CODES,
  REASON_CODE_PATTERN,
  auditCategories,
  auditOutcomes,
  categoryForReasonCode,
  isReasonCode,
  type ReasonCode,
} from '../src/audit/reason-codes'

describe('领域审计原因码注册表（ADR-0040 决策 3）', () => {
  it('每个码都是 `<域>.<事件>` 且两段都是 lower_snake', () => {
    // 与迁移里的 CHECK domain_audit_event_reason_code_namespaced 同一个正则：
    // 这里写成 camelCase 编译期照样通过，只有库会在运行时拒绝。
    for (const code of Object.keys(REASON_CODES)) {
      expect(code, code).toMatch(REASON_CODE_PATTERN)
    }
  })

  it('每个码的分域都在 AuditCategory 之内', () => {
    for (const category of Object.values(REASON_CODES)) {
      expect(auditCategories).toContain(category)
    }
  })

  it('T12a 的四类预算判定都已注册且一律 BUDGET', () => {
    // 这四个码与 outcome 由 T12 事务入口契约的表定死，实现侧不另起名字。
    const budgetCodes: readonly ReasonCode[] = [
      'budget.reserve_rejected',
      'budget.pool_boundary_rejected',
      'budget.settlement_delta',
      'budget.lease_expired',
    ]
    for (const code of budgetCodes) {
      expect(isReasonCode(code)).toBe(true)
      expect(categoryForReasonCode(code)).toBe('BUDGET')
    }
  })

  it('注册表被冻结：不能在运行时往里塞码', () => {
    expect(Object.isFrozen(REASON_CODES)).toBe(true)
  })

  it('未注册的码 isReasonCode 返回 false', () => {
    expect(isReasonCode('budget.made_up')).toBe(false)
    expect(isReasonCode('')).toBe(false)
    // 原型链上的键不算注册（hasOwnProperty 而不是 in）。
    expect(isReasonCode('toString')).toBe(false)
    expect(isReasonCode('constructor')).toBe(false)
  })

  it('outcome 四值与读侧口径一致', () => {
    expect([...auditOutcomes]).toEqual(['ALLOWED', 'DENIED', 'DEGRADED', 'RECLAIMED'])
  })

  it('分域七值与 ADR-0040 的域划分一致', () => {
    expect([...auditCategories]).toEqual([
      'BUDGET',
      'AUTHZ',
      'MEMBERSHIP',
      'DATA_CLASS',
      'INJECTION',
      'EVIDENCE',
      'DELETION',
    ])
  })
})
