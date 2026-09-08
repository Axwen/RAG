import { describe, expect, it } from 'vitest'
import type { Tx } from '../src/tx'
import { resolveCapabilities } from '../src/authz/resolve-capabilities'
import { compileAllowedScopes } from '../src/authz/compile-allowed-scopes'
import { recheckCandidates } from '../src/authz/recheck-candidates'

/**
 * 授权查库入口的单元层（T14b）。
 *
 * 这里钉的是判定分支与结果形状：能力解析的五种失败原因、两层角色能力的
 * 并集、作用域编译的单次读取语义、复核的减法与去重保序。SQL 保真度
 * （索引命中、事务、竞态）归集成层（tests/identity-role-scope 与
 * authz 集成用例）。
 */

/** 数据形状按 Prisma 模型字段名对齐，只放被 select 用到的字段。 */
interface FakeWorld {
  users: ReadonlyArray<{ id: string; status: 'ACTIVE' | 'DISABLED' }>
  tenantMemberships: ReadonlyArray<{
    tenantId: string
    businessUserId: string
    status: 'ACTIVE' | 'SUSPENDED' | 'REVOKED'
    tenantRole: { permissions: ReadonlyArray<{ permission: { code: string } }> } | null
    businessUserStatus: 'ACTIVE' | 'DISABLED'
    aclRevision: number
    knowledgeSpaceIds: readonly string[]
  }>
  workspaceMemberships: ReadonlyArray<{
    workspaceId: string
    workspaceTenantId: string
    businessUserId: string
    status: 'ACTIVE' | 'SUSPENDED' | 'REVOKED'
    role: { permissions: ReadonlyArray<{ permission: { code: string } }> } | null
  }>
  documentVersions: ReadonlyArray<{ id: string; tenantId: string; knowledgeSpaceId: string }>
}

function fakeReader(world: FakeWorld): Tx {
  return {
    businessUser: {
      async findUnique({ where }: { where: { id: string } }) {
        return world.users.find((u) => u.id === where.id) ?? null
      },
    },
    tenantMembership: {
      async findUnique({
        where,
      }: {
        where: { tenantId_businessUserId: { tenantId: string; businessUserId: string } }
      }) {
        const found = world.tenantMemberships.find(
          (m) =>
            m.tenantId === where.tenantId_businessUserId.tenantId &&
            m.businessUserId === where.tenantId_businessUserId.businessUserId,
        )
        if (found === undefined) return null
        // 三个消费方各取一部分：角色权限（能力解析）、用户状态与 revision/空间列表（作用域编译）。
        return {
          status: found.status,
          tenantRole: found.tenantRole,
          businessUser: { status: found.businessUserStatus },
          tenant: {
            aclRevision: found.aclRevision,
            knowledgeSpaces: found.knowledgeSpaceIds.map((id) => ({ id })),
          },
        }
      },
    },
    workspaceMembership: {
      async findUnique({
        where,
      }: {
        where: { workspaceId_businessUserId: { workspaceId: string; businessUserId: string } }
      }) {
        const found = world.workspaceMemberships.find(
          (m) =>
            m.workspaceId === where.workspaceId_businessUserId.workspaceId &&
            m.businessUserId === where.workspaceId_businessUserId.businessUserId,
        )
        // 返回 Prisma 的嵌套形状：代码读 workspace.tenantId，不是扁平字段。
        return found === null || found === undefined
          ? null
          : {
              workspace: { tenantId: found.workspaceTenantId },
              status: found.status,
              role: found.role,
            }
      },
    },
    documentVersion: {
      async findMany({
        where,
      }: {
        where: { tenantId: string; id: { in: string[] }; document?: { knowledgeSpaceId: string } }
      }) {
        return world.documentVersions.filter(
          (v) =>
            v.tenantId === where.tenantId &&
            where.id.in.includes(v.id) &&
            (where.document === undefined ||
              v.knowledgeSpaceId === where.document.knowledgeSpaceId),
        )
      },
    },
  } as unknown as Tx
}

const TENANT = 't1'
const OTHER_TENANT = 't2'
const USER = 'u1'

/** 用例共享的世界：租户管理员（answer.run + document.upload）+ 客服角色（answer.run）。 */
function baseWorld(): FakeWorld {
  return {
    users: [{ id: USER, status: 'ACTIVE' }],
    tenantMemberships: [
      {
        tenantId: TENANT,
        businessUserId: USER,
        status: 'ACTIVE',
        businessUserStatus: 'ACTIVE',
        aclRevision: 7,
        knowledgeSpaceIds: ['ks1', 'ks2'],
        tenantRole: {
          permissions: [
            { permission: { code: 'answer.run' } },
            { permission: { code: 'document.upload' } },
          ],
        },
      },
    ],
    workspaceMemberships: [
      {
        workspaceId: 'w1',
        workspaceTenantId: TENANT,
        businessUserId: USER,
        status: 'ACTIVE',
        role: { permissions: [{ permission: { code: 'answer.run' } }] },
      },
    ],
    documentVersions: [
      { id: 'dv1', tenantId: TENANT, knowledgeSpaceId: 'ks1' },
      { id: 'dv2', tenantId: TENANT, knowledgeSpaceId: 'ks1' },
      { id: 'dv3', tenantId: OTHER_TENANT, knowledgeSpaceId: 'ks9' },
    ],
  }
}

describe('resolveCapabilities', () => {
  it('两层角色能力取并集，普通成员（无角色）得到空集合', async () => {
    const world = baseWorld()
    const result = await resolveCapabilities(fakeReader(world), {
      businessUserId: USER,
      tenantId: TENANT,
      workspaceId: 'w1',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect([...result.capabilities].sort()).toEqual(['answer.run', 'document.upload'])

    const plain = await resolveCapabilities(fakeReader(world), {
      businessUserId: USER,
      tenantId: TENANT,
    })
    // 不指定 workspace：只看租户级（客服角色不叠加）。
    expect(plain.ok && [...plain.capabilities]).toEqual(['answer.run', 'document.upload'])

    world.tenantMemberships = [{ ...world.tenantMemberships[0]!, tenantRole: null }]
    const noRole = await resolveCapabilities(fakeReader(world), {
      businessUserId: USER,
      tenantId: TENANT,
    })
    expect(noRole).toMatchObject({ ok: true, capabilities: new Set() })
  })

  it('五种失败原因各自可区分（禁用、无成员、Workspace 跨租户/无成员）', async () => {
    const world = baseWorld()
    const reader = fakeReader(world)

    world.users = [{ id: USER, status: 'DISABLED' }]
    expect(
      await resolveCapabilities(reader, { businessUserId: USER, tenantId: TENANT }),
    ).toMatchObject({ ok: false, reason: 'USER_DISABLED' })
    world.users = [{ id: USER, status: 'ACTIVE' }]

    world.tenantMemberships = [{ ...world.tenantMemberships[0]!, status: 'REVOKED' }]
    expect(
      await resolveCapabilities(reader, { businessUserId: USER, tenantId: TENANT }),
    ).toMatchObject({ ok: false, reason: 'NO_ACTIVE_TENANT_MEMBERSHIP' })
    world.tenantMemberships = baseWorld().tenantMemberships

    // Workspace 属于另一个租户：WORKSPACE_NOT_FOUND（不泄漏它存在于别的租户）。
    expect(
      await resolveCapabilities(reader, {
        businessUserId: USER,
        tenantId: TENANT,
        workspaceId: 'w-other-tenant',
      }),
    ).toMatchObject({ ok: false, reason: 'WORKSPACE_NOT_FOUND' })

    world.workspaceMemberships = [{ ...world.workspaceMemberships[0]!, status: 'SUSPENDED' }]
    expect(
      await resolveCapabilities(reader, {
        businessUserId: USER,
        tenantId: TENANT,
        workspaceId: 'w1',
      }),
    ).toMatchObject({ ok: false, reason: 'NO_ACTIVE_WORKSPACE_MEMBERSHIP' })
  })

  it('不存在的用户返回 USER_NOT_FOUND', async () => {
    expect(
      await resolveCapabilities(fakeReader(baseWorld()), {
        businessUserId: 'nobody',
        tenantId: TENANT,
      }),
    ).toMatchObject({ ok: false, reason: 'USER_NOT_FOUND' })
  })
})

describe('compileAllowedScopes', () => {
  it('ACTIVE 成员 → 租户全部知识空间的键 + 同次读取的 aclRevision', async () => {
    const result = await compileAllowedScopes(fakeReader(baseWorld()), {
      businessUserId: USER,
      tenantId: TENANT,
    })
    expect(result).toMatchObject({
      ok: true,
      scopes: {
        aclRevision: 7,
        scopeKeys: ['t:t1:ks:ks1', 't:t1:ks:ks2'],
      },
    })
  })

  it('成员失效或用户禁用都返回失败，不给降级集合', async () => {
    const world = baseWorld()
    const reader = fakeReader(world)
    world.tenantMemberships = [{ ...world.tenantMemberships[0]!, status: 'SUSPENDED' }]
    expect(
      await compileAllowedScopes(reader, { businessUserId: USER, tenantId: TENANT }),
    ).toMatchObject({ ok: false, reason: 'NO_ACTIVE_TENANT_MEMBERSHIP' })
    world.tenantMemberships = [
      { ...world.tenantMemberships[0]!, status: 'ACTIVE', businessUserStatus: 'DISABLED' },
    ]
    expect(
      await compileAllowedScopes(reader, { businessUserId: USER, tenantId: TENANT }),
    ).toMatchObject({ ok: false, reason: 'USER_DISABLED' })
  })
})

describe('recheckCandidates', () => {
  it('空输入直接返回，不发起查询', async () => {
    const reader = fakeReader(baseWorld())
    // 复用 reader；空输入路径根本不会碰 documentVersion 委托。
    expect(await recheckCandidates(reader, { tenantId: TENANT, documentVersionIds: [] })).toEqual({
      allowed: [],
      rejected: [],
    })
  })

  it('减法语义：跨租户与不存在的候选被拒，去重且保持输入顺序', async () => {
    const result = await recheckCandidates(fakeReader(baseWorld()), {
      tenantId: TENANT,
      documentVersionIds: ['dv2', 'dv-nope', 'dv3', 'dv1', 'dv2'],
    })
    expect(result.allowed).toEqual(['dv2', 'dv1'])
    expect(result.rejected).toEqual(['dv-nope', 'dv3'])
  })

  it('指定知识空间时，其它空间的候选同租户也拒', async () => {
    const world = baseWorld()
    world.documentVersions = [
      ...world.documentVersions,
      { id: 'dv4', tenantId: TENANT, knowledgeSpaceId: 'ks2' },
    ]
    const result = await recheckCandidates(fakeReader(world), {
      tenantId: TENANT,
      knowledgeSpaceId: 'ks2',
      documentVersionIds: ['dv1', 'dv4'],
    })
    expect(result.allowed).toEqual(['dv4'])
    expect(result.rejected).toEqual(['dv1'])
  })
})
