import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  bumpAclRevision,
  compileAllowedScopes,
  createPrismaClient,
  recheckCandidates,
  resolveCapabilities,
  type PrismaClient,
} from '@rag/database'
import { scopeKeyForKnowledgeSpace } from '@rag/contracts'

/**
 * 授权链路的 PostgreSQL 集成（T14b / ADR-0026）。
 *
 * 这一层的价值是单元层替不了的：
 * - 撤权后作用域集合**立即**收窄——aclRevision 递增与成员状态在同一事务，
 *   下一次编译看到的集合就是新的（「下一次查询即生效」这条 ADR-0026 的承诺）。
 * - 复核的批量查询真的过 (tenantId, id) 唯一索引，减法语义在真库上成立。
 * - 能力并集经过 RolePermission 关联表，跨租户的角色引用被复合外键挡住。
 *
 * 不测的：Redis 缓存失效（缓存层未落地，T6 接线时验）；OpenSearch filter
 * （索引不存在，T5/T6）；复核超时的 fail closed（查库抛错的传播在单元层
 * authorization.service.test.ts，这里不人为搞挂数据库）。
 */

let prisma: PrismaClient

/** 每个文件一个独立租户，用例之间不共享成员关系。 */
const tenantId = randomUUID()
const otherTenantId = randomUUID()
const userId = randomUUID()
const otherUserId = randomUUID()
const spaceIn = randomUUID()
const spaceOther = randomUUID()
const workspaceIn = randomUUID()
const workspaceOther = randomUUID()

beforeAll(async () => {
  prisma = createPrismaClient()
  await prisma.tenant.create({ data: { id: tenantId, name: `t14b-int-${tenantId.slice(0, 8)}` } })
  await prisma.tenant.create({
    data: { id: otherTenantId, name: `t14b-int-${otherTenantId.slice(0, 8)}` },
  })
  await prisma.businessUser.create({
    data: {
      id: userId,
      issuer: 'https://int.test',
      subject: `sub-${userId}`,
      displayName: '主体A',
    },
  })
  await prisma.businessUser.create({
    data: {
      id: otherUserId,
      issuer: 'https://int.test',
      subject: `sub-${otherUserId}`,
      displayName: '主体B',
    },
  })
  await prisma.knowledgeSpace.create({
    data: { id: spaceIn, tenantId, slug: 'in', name: '本租户空间' },
  })
  await prisma.knowledgeSpace.create({
    data: { id: spaceOther, tenantId: otherTenantId, slug: 'other', name: '他租户空间' },
  })
})

afterAll(async () => {
  // 按名字模式清（t14b-int-*）：既清本次运行，也自愈此前中断运行留下的孤儿租户
  // ——按 id 清会让一次崩溃永久污染开发库。顺序按外键依赖：成员/绑定 → 角色
  // → 权限 → 文档 → 空间 → 用户 → 租户；不用级联删除，RESTRICT 正是我们要保的。
  const stale = await prisma.tenant.findMany({
    where: { name: { startsWith: 't14b-int-' } },
    select: { id: true },
  })
  const staleIds = stale.map((t) => t.id)
  if (staleIds.length > 0) {
    await prisma.workspaceMembership.deleteMany({ where: { tenantId: { in: staleIds } } })
    await prisma.tenantMembership.deleteMany({ where: { tenantId: { in: staleIds } } })
    await prisma.rolePermission.deleteMany({ where: { role: { tenantId: { in: staleIds } } } })
    await prisma.role.deleteMany({ where: { tenantId: { in: staleIds } } })
    await prisma.documentVersion.deleteMany({ where: { tenantId: { in: staleIds } } })
    await prisma.document.deleteMany({ where: { tenantId: { in: staleIds } } })
    await prisma.workspace.deleteMany({ where: { tenantId: { in: staleIds } } })
    await prisma.knowledgeSpace.deleteMany({ where: { tenantId: { in: staleIds } } })
    // 本次运行的两个用户按 id 清；此前中断运行的用户按展示名兜底（跨租户表，
    // 不阻塞租户删除，但会无限累积）。
    await prisma.businessUser.deleteMany({
      where: { OR: [{ id: { in: [userId, otherUserId] } }, { displayName: { in: ['主体A', '主体B'] } }] },
    })
    await prisma.tenant.deleteMany({ where: { id: { in: staleIds } } })
  }
  await prisma.permission.deleteMany({ where: { code: { startsWith: 'int.' } } })
  await prisma.$disconnect()
})

/** 造一套角色+权限码并绑定到指定成员关系。 */
async function grant(
  tenant: string,
  user: string,
  options: { scope: 'TENANT' | 'WORKSPACE'; codes: string[]; workspaceId?: string },
): Promise<void> {
  const role = await prisma.role.create({
    data: {
      id: randomUUID(),
      tenantId: tenant,
      scope: options.scope,
      code: `role-${randomUUID().slice(0, 8)}`,
      name: '集成角色',
    },
  })
  for (const code of options.codes) {
    const permission = await prisma.permission.upsert({
      where: { code },
      create: { id: randomUUID(), code, name: `集成权限 ${code}` },
      update: {},
    })
    await prisma.rolePermission.create({
      data: { id: randomUUID(), roleId: role.id, permissionId: permission.id },
    })
  }
  if (options.scope === 'TENANT') {
    await prisma.tenantMembership.update({
      where: { tenantId_businessUserId: { tenantId: tenant, businessUserId: user } },
      data: { tenantRoleId: role.id },
    })
  } else {
    await prisma.workspaceMembership.update({
      where: {
        workspaceId_businessUserId: { workspaceId: options.workspaceId!, businessUserId: user },
      },
      data: { roleId: role.id },
    })
  }
}

describe('作用域编译与撤权（ADR-0026 第一段）', () => {
  it('ACTIVE 成员 → 租户全部知识空间的键', async () => {
    await prisma.tenantMembership.create({
      data: { id: randomUUID(), tenantId, businessUserId: userId },
    })
    const result = await compileAllowedScopes(prisma, { businessUserId: userId, tenantId })
    expect(result).toMatchObject({
      ok: true,
      scopes: {
        scopeKeys: [scopeKeyForKnowledgeSpace(tenantId, spaceIn)],
        // 新租户从 aclRevision=0 开始
        aclRevision: 0,
      },
    })
  })

  it('撤权（REVOKED）+ revision 递增在同一事务：下一次编译立即收窄', async () => {
    await prisma.$transaction(async (tx) => {
      await tx.tenantMembership.update({
        where: { tenantId_businessUserId: { tenantId, businessUserId: userId } },
        data: { status: 'REVOKED', revokedAt: new Date() },
      })
      await bumpAclRevision(tx, tenantId)
    })
    const after = await compileAllowedScopes(prisma, { businessUserId: userId, tenantId })
    expect(after).toMatchObject({ ok: false, reason: 'NO_ACTIVE_TENANT_MEMBERSHIP' })

    // revision 确实递增了（缓存键失效的依据）。
    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } })
    expect(tenant?.aclRevision).toBe(1)
  })

  it('重新激活成员关系后作用域恢复', async () => {
    await prisma.tenantMembership.update({
      where: { tenantId_businessUserId: { tenantId, businessUserId: userId } },
      data: { status: 'ACTIVE', revokedAt: null },
    })
    const restored = await compileAllowedScopes(prisma, { businessUserId: userId, tenantId })
    expect(restored).toMatchObject({ ok: true })
  })
})

describe('能力解析（跨租户与两层并集）', () => {
  const code = `int.${tenantId.slice(0, 8)}.answer.run`
  const wsCode = `int.${tenantId.slice(0, 8)}.document.upload`

  it('租户级与 Workspace 级角色能力并集；跨租户 Workspace 拒绝', async () => {
    await prisma.workspace.create({
      data: { id: workspaceIn, tenantId, slug: 'desk-in', name: '本租户工作台' },
    })
    await prisma.workspaceMembership.create({
      data: {
        id: randomUUID(),
        tenantId,
        workspaceId: workspaceIn,
        businessUserId: userId,
      },
    })
    await grant(tenantId, userId, { scope: 'TENANT', codes: [code] })
    await grant(tenantId, userId, { scope: 'WORKSPACE', codes: [wsCode], workspaceId: workspaceIn })

    const result = await resolveCapabilities(prisma, {
      businessUserId: userId,
      tenantId,
      workspaceId: workspaceIn,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect([...result.capabilities].sort()).toEqual([code, wsCode].sort())

    // 跨租户的 Workspace id：WORKSPACE_NOT_FOUND（不泄漏它在别的租户存在）。
    await prisma.workspace.create({
      data: {
        id: workspaceOther,
        tenantId: otherTenantId,
        slug: 'desk-other',
        name: '他租户工作台',
      },
    })
    const cross = await resolveCapabilities(prisma, {
      businessUserId: userId,
      tenantId,
      workspaceId: workspaceOther,
    })
    expect(cross).toMatchObject({ ok: false, reason: 'WORKSPACE_NOT_FOUND' })
  })

  it('他租户成员在该租户解析能力 → NO_ACTIVE_TENANT_MEMBERSHIP', async () => {
    await prisma.tenantMembership.create({
      data: { id: randomUUID(), tenantId: otherTenantId, businessUserId: otherUserId },
    })
    const result = await resolveCapabilities(prisma, {
      businessUserId: otherUserId,
      tenantId,
    })
    expect(result).toMatchObject({ ok: false, reason: 'NO_ACTIVE_TENANT_MEMBERSHIP' })
  })
})

describe('候选复核（ADR-0026 第二段）', () => {
  it('真实存在的文档版本放行，跨租户/不存在的剔除', async () => {
    const doc = await prisma.document.create({
      data: { id: randomUUID(), tenantId, knowledgeSpaceId: spaceIn },
    })
    const versionIn = await prisma.documentVersion.create({
      data: {
        id: randomUUID(),
        tenantId,
        documentId: doc.id,
        version: 1,
        sourceFormat: 'pdf',
        dataClass: 'INTERNAL',
        contentHash: `h-${randomUUID()}`,
        objectKey: `s3://int/${randomUUID()}`,
        sizeBytes: 100,
      },
    })
    const docOther = await prisma.document.create({
      data: { id: randomUUID(), tenantId: otherTenantId, knowledgeSpaceId: spaceOther },
    })
    const versionOther = await prisma.documentVersion.create({
      data: {
        id: randomUUID(),
        tenantId: otherTenantId,
        documentId: docOther.id,
        version: 1,
        sourceFormat: 'pdf',
        dataClass: 'INTERNAL',
        contentHash: `h-${randomUUID()}`,
        objectKey: `s3://int/${randomUUID()}`,
        sizeBytes: 100,
      },
    })

    const result = await recheckCandidates(prisma, {
      tenantId,
      documentVersionIds: [versionIn.id, versionOther.id, '00000000-0000-0000-0000-0000000000ff'],
    })
    expect(result.allowed).toEqual([versionIn.id])
    expect(result.rejected).toEqual([versionOther.id, '00000000-0000-0000-0000-0000000000ff'])

    // 用指定知识空间再收紧一档。
    const narrowed = await recheckCandidates(prisma, {
      tenantId,
      knowledgeSpaceId: spaceOther,
      documentVersionIds: [versionIn.id],
    })
    expect(narrowed.allowed).toEqual([])
    expect(narrowed.rejected).toEqual([versionIn.id])
  })
})
