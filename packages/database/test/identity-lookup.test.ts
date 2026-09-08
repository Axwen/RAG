import { describe, expect, it } from 'vitest'
import type { PrismaClient } from '../src/generated/prisma/client'
import type { Tx } from '../src/tx'
import { loadIdentityContext } from '../src/identity/load-identity-context'

/**
 * 身份装配的单元层（T14a / ADR-0039）。
 *
 * 这一层钉的是**装配判定**：找不到/DISABLED 的判别联合、角色引用的投影、
 * Workspace 的 tenantId 随 Workspace 携带。SQL 与 include 的保真度归集成层
 * （`tests/` 跑在已迁移的 PostgreSQL 上），这里不重复。
 *
 * 假客户端只实现 `$transaction` 和事务内的 `businessUser.findUnique`：这是
 * 入口唯一的数据库交互，多实现一个方法就多一处与真实语义无关的猜测。
 */

/** 最小可断言的用户行，字段名与 Prisma 模型一致。 */
interface FakeBusinessUser {
  id: string
  issuer: string
  subject: string
  displayName: string
  email: string | null
  status: 'ACTIVE' | 'DISABLED'
  tenantMemberships: ReadonlyArray<{
    tenantId: string
    status: 'ACTIVE' | 'SUSPENDED' | 'REVOKED'
    tenantRole: { id: string; code: string; name: string } | null
  }>
  workspaceMemberships: ReadonlyArray<{
    workspaceId: string
    status: 'ACTIVE' | 'SUSPENDED' | 'REVOKED'
    role: { id: string; code: string; name: string } | null
    workspace: { tenantId: string; slug: string; name: string }
  }>
}

function fakePrisma(users: readonly FakeBusinessUser[]): {
  readonly client: PrismaClient
  readonly transactionCalls: () => number
} {
  const tx = {
    businessUser: {
      async findUnique({
        where,
      }: {
        where: { issuer_subject: { issuer: string; subject: string } }
      }) {
        return (
          users.find(
            (u) =>
              u.issuer === where.issuer_subject.issuer &&
              u.subject === where.issuer_subject.subject,
          ) ?? null
        )
      },
    },
  } as unknown as Tx
  let calls = 0
  return {
    client: {
      async $transaction(callback: (transaction: Tx) => Promise<unknown>): Promise<unknown> {
        calls += 1
        return callback(tx)
      },
    } as unknown as PrismaClient,
    transactionCalls: () => calls,
  }
}

const issuer = 'http://localhost:8080/realms/rag-local'

describe('loadIdentityContext', () => {
  it('装配租户与 Workspace 成员及角色引用', async () => {
    const prisma = fakePrisma([
      {
        id: 'u1',
        issuer,
        subject: 'kc-1',
        displayName: '本地客服',
        email: 'agent@example.test',
        status: 'ACTIVE',
        tenantMemberships: [
          {
            tenantId: 't1',
            status: 'ACTIVE',
            tenantRole: { id: 'r0', code: 'tenant-admin', name: '租户管理员' },
          },
        ],
        workspaceMemberships: [
          {
            workspaceId: 'w1',
            status: 'ACTIVE',
            role: { id: 'r1', code: 'agent', name: '客服' },
            workspace: { tenantId: 't1', slug: 'agent-desk', name: '客服工作台' },
          },
          {
            workspaceId: 'w2',
            status: 'ACTIVE',
            role: null,
            workspace: { tenantId: 't1', slug: 'eng-desk', name: '研发工作台' },
          },
        ],
      },
    ])

    const result = await loadIdentityContext(prisma.client, { issuer, subject: 'kc-1' })

    expect(prisma.transactionCalls()).toBe(1)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.context.businessUserId).toBe('u1')
    expect(result.context.tenantMemberships).toHaveLength(1)
    expect(result.context.tenantMemberships[0]?.tenantRole?.code).toBe('tenant-admin')
    // tenantId 从 Workspace 取，不从成员行列取——成员行的 tenantId 与
    // workspace.tenantId 不一致时以权威侧（workspace）为准。
    expect(result.context.workspaceMemberships.map((m) => [m.tenantId, m.slug])).toEqual([
      ['t1', 'agent-desk'],
      ['t1', 'eng-desk'],
    ])
    // 同一用户多 Workspace、不同角色（ADR-0039 决策 3），逐 Workspace 携带。
    expect(result.context.workspaceMemberships.map((m) => m.role?.code ?? null)).toEqual([
      'agent',
      null,
    ])
  })

  it('未建立映射的外部身份返回 USER_NOT_FOUND，不自动建档', async () => {
    const prisma = fakePrisma([])
    const result = await loadIdentityContext(prisma.client, { issuer, subject: 'nobody' })
    expect(result).toEqual({ ok: false, reason: 'USER_NOT_FOUND' })
  })

  it('DISABLED 用户返回 USER_DISABLED，即使成员关系仍是 ACTIVE', async () => {
    const prisma = fakePrisma([
      {
        id: 'u2',
        issuer,
        subject: 'kc-2',
        displayName: '被禁用户',
        email: null,
        status: 'DISABLED',
        tenantMemberships: [{ tenantId: 't1', status: 'ACTIVE', tenantRole: null }],
        workspaceMemberships: [],
      },
    ])
    const result = await loadIdentityContext(prisma.client, { issuer, subject: 'kc-2' })
    expect(result).toEqual({ ok: false, reason: 'USER_DISABLED' })
  })

  it('SUSPENDED/REVOKED 成员照实携带，不在装配层过滤', async () => {
    const prisma = fakePrisma([
      {
        id: 'u3',
        issuer,
        subject: 'kc-3',
        displayName: '部分撤权用户',
        email: null,
        status: 'ACTIVE',
        tenantMemberships: [{ tenantId: 't1', status: 'REVOKED', tenantRole: null }],
        workspaceMemberships: [
          {
            workspaceId: 'w1',
            status: 'SUSPENDED',
            role: { id: 'r1', code: 'agent', name: '客服' },
            workspace: { tenantId: 't1', slug: 'agent-desk', name: '客服工作台' },
          },
        ],
      },
    ])
    const result = await loadIdentityContext(prisma.client, { issuer, subject: 'kc-3' })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.context.tenantMemberships[0]?.status).toBe('REVOKED')
    expect(result.context.workspaceMemberships[0]?.status).toBe('SUSPENDED')
  })
})
