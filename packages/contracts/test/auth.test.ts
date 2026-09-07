import { describe, expect, it } from 'vitest'
import type { ServerIdentityContext } from '../src/auth'
import { toSessionView } from '../src/auth'

/**
 * 身份上下文契约（T14a / ADR-0039）。
 *
 * SessionView 是唯一对前端暴露的投影：这里钉住「哪些字段进、哪些不进」
 * ——issuer/subject 是服务端映射键，随会话响应外发等于把外部身份的
 * 稳定标识送给任何拿到 cookie 的脚本环境。
 */

const context: ServerIdentityContext = {
  businessUserId: 'u1',
  issuer: 'http://localhost:8080/realms/rag-local',
  subject: 'kc-1',
  displayName: 'Dev User',
  email: 'dev@example.invalid',
  userStatus: 'ACTIVE',
  tenantMemberships: [
    {
      tenantId: 't1',
      status: 'ACTIVE',
      tenantRole: { id: 'r0', code: 'tenant-admin', name: '租户管理员' },
    },
    {
      // 非 ACTIVE 成员照实携带（装配层不过滤，判定归 T14b 授权入口）。
      tenantId: 't2',
      status: 'REVOKED',
      tenantRole: null,
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
    {
      tenantId: 't1',
      workspaceId: 'w2',
      slug: 'eng-desk',
      name: '研发工作台',
      status: 'ACTIVE',
      role: null,
    },
  ],
}

describe('toSessionView', () => {
  it('不携带 issuer/subject（服务端映射键不外发）', () => {
    const view = toSessionView(context)
    expect(view).not.toHaveProperty('issuer')
    expect(view).not.toHaveProperty('subject')
  })

  it('租户与 Workspace 成员逐条投影，角色缺省为 null', () => {
    const view = toSessionView(context)
    expect(view.tenants).toEqual([
      { tenantId: 't1', tenantRoleCode: 'tenant-admin' },
      { tenantId: 't2', tenantRoleCode: null },
    ])
    expect(view.workspaces).toEqual([
      {
        tenantId: 't1',
        workspaceId: 'w1',
        slug: 'agent-desk',
        name: '客服工作台',
        roleCode: 'agent',
      },
      { tenantId: 't1', workspaceId: 'w2', slug: 'eng-desk', name: '研发工作台', roleCode: null },
    ])
  })

  it('基本资料字段直通', () => {
    const view = toSessionView(context)
    expect(view.businessUserId).toBe('u1')
    expect(view.displayName).toBe('Dev User')
    expect(view.email).toBe('dev@example.invalid')
  })
})
