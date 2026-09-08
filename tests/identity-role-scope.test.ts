import { afterAll, describe, expect, it } from 'vitest'
import { IntegrationDb } from './helpers/integration-db'

/**
 * T14a 角色边界跑在真 PostgreSQL 上。
 *
 * schema 静态断言只能证明迁移文本存在，不能证明复合外键和 trigger 真正阻止了
 * 越租户绑定、scope 错配和已引用角色的 scope 修改。每个场景都在独立事务中
 * 构造数据并让最后一条非法写入失败，事务整体回滚，不留下测试身份数据。
 */

const db = new IntegrationDb()

afterAll(async () => {
  await db.cleanup()
})

async function expectConstraintViolation(action: () => Promise<unknown>): Promise<void> {
  await expect(action()).rejects.toThrow()
}

async function createTenant(
  tx: Parameters<Parameters<typeof db.prisma.$transaction>[0]>[0],
  name: string,
) {
  return tx.tenant.create({ data: { name } })
}

describe('T14a RoleScope 与租户边界（真 PostgreSQL）', () => {
  it('复合外键拒绝把其他租户的角色绑定到本租户成员', async () => {
    await expect(
      db.prisma.$transaction(async (tx) => {
        const tenantA = await createTenant(tx, 'identity-boundary-a')
        const tenantB = await createTenant(tx, 'identity-boundary-b')
        const user = await tx.businessUser.create({
          data: {
            issuer: 'https://identity-boundary.test',
            subject: 'cross-tenant-role',
            displayName: 'Boundary User',
          },
        })
        const roleB = await tx.role.create({
          data: {
            tenantId: tenantB.id,
            scope: 'TENANT',
            code: 'tenant-b-admin',
            name: 'Tenant B Admin',
          },
        })

        await tx.tenantMembership.create({
          data: { tenantId: tenantA.id, businessUserId: user.id, tenantRoleId: roleB.id },
        })
      }),
    ).rejects.toThrow()
  })

  it('TenantMembership trigger 拒绝绑定 WORKSPACE 角色', async () => {
    await expect(
      db.prisma.$transaction(async (tx) => {
        const tenant = await createTenant(tx, 'tenant-membership-scope')
        const user = await tx.businessUser.create({
          data: {
            issuer: 'https://identity-boundary.test',
            subject: 'tenant-scope',
            displayName: 'Boundary User',
          },
        })
        const role = await tx.role.create({
          data: {
            tenantId: tenant.id,
            scope: 'WORKSPACE',
            code: 'workspace-role',
            name: 'Workspace Role',
          },
        })

        await tx.tenantMembership.create({
          data: { tenantId: tenant.id, businessUserId: user.id, tenantRoleId: role.id },
        })
      }),
    ).rejects.toThrow()
  })

  it('WorkspaceMembership trigger 拒绝绑定 TENANT 角色', async () => {
    await expect(
      db.prisma.$transaction(async (tx) => {
        const tenant = await createTenant(tx, 'workspace-membership-scope')
        const user = await tx.businessUser.create({
          data: {
            issuer: 'https://identity-boundary.test',
            subject: 'workspace-scope',
            displayName: 'Boundary User',
          },
        })
        const role = await tx.role.create({
          data: { tenantId: tenant.id, scope: 'TENANT', code: 'tenant-role', name: 'Tenant Role' },
        })
        const workspace = await tx.workspace.create({
          data: { tenantId: tenant.id, slug: 'workspace', name: 'Workspace' },
        })

        await tx.workspaceMembership.create({
          data: {
            tenantId: tenant.id,
            workspaceId: workspace.id,
            businessUserId: user.id,
            roleId: role.id,
          },
        })
      }),
    ).rejects.toThrow()
  })

  it('已被 TenantMembership 引用的角色不能切换为 WORKSPACE scope', async () => {
    await expectConstraintViolation(() =>
      db.prisma.$transaction(async (tx) => {
        const tenant = await createTenant(tx, 'tenant-scope-change')
        const user = await tx.businessUser.create({
          data: {
            issuer: 'https://identity-boundary.test',
            subject: 'tenant-scope-change',
            displayName: 'Boundary User',
          },
        })
        const role = await tx.role.create({
          data: { tenantId: tenant.id, scope: 'TENANT', code: 'tenant-role', name: 'Tenant Role' },
        })
        await tx.tenantMembership.create({
          data: { tenantId: tenant.id, businessUserId: user.id, tenantRoleId: role.id },
        })

        await tx.role.update({ where: { id: role.id }, data: { scope: 'WORKSPACE' } })
      }),
    )
  })

  it('已被 WorkspaceMembership 引用的角色不能切换为 TENANT scope', async () => {
    await expectConstraintViolation(() =>
      db.prisma.$transaction(async (tx) => {
        const tenant = await createTenant(tx, 'workspace-scope-change')
        const user = await tx.businessUser.create({
          data: {
            issuer: 'https://identity-boundary.test',
            subject: 'workspace-scope-change',
            displayName: 'Boundary User',
          },
        })
        const role = await tx.role.create({
          data: {
            tenantId: tenant.id,
            scope: 'WORKSPACE',
            code: 'workspace-role',
            name: 'Workspace Role',
          },
        })
        const workspace = await tx.workspace.create({
          data: { tenantId: tenant.id, slug: 'workspace', name: 'Workspace' },
        })
        await tx.workspaceMembership.create({
          data: {
            tenantId: tenant.id,
            workspaceId: workspace.id,
            businessUserId: user.id,
            roleId: role.id,
          },
        })

        await tx.role.update({ where: { id: role.id }, data: { scope: 'TENANT' } })
      }),
    )
  })
})
