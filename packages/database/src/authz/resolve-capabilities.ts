import type { PrismaClient } from '../generated/prisma/client'
import type { Tx } from '../tx'

/**
 * 能力权限解析（T14b / ADR-0039 决策 2）。
 *
 * 统一授权入口的能力层：按 businessUser + tenant (+ workspace) 解析出
 * ACTIVE 成员关系下的能力码集合。只回答「能执行哪些操作」，不参与
 * acl_scope_key 编译——作用域只由成员关系与资源策略推导，角色维度
 * 不得渗进索引预过滤。
 *
 * 集合来源是两层角色的并集：租户级角色（tenantRole，租户范围内生效）
 * 与 Workspace 角色（指定 workspaceId 时，该 Workspace 的成员角色）。
 * 普通成员（角色为 null）得到空集合——存在成员关系但没有能力，这是
 * 合法状态，不是失败。
 *
 * 判别联合而非抛异常，与预算事务入口同一风格：调用方（统一授权入口）
 * 要把每种失败映射成不同的拒绝原因，异常会把这个信息压扁。
 */

/** 解析能力时的执行句柄：只读查询，PrismaClient 或 Tx 均可。 */
type Reader = PrismaClient | Tx

export type CapabilityResolution =
  | { readonly ok: true; readonly capabilities: ReadonlySet<string> }
  | {
      readonly ok: false
      readonly reason:
        | 'USER_NOT_FOUND'
        | 'USER_DISABLED'
        | 'NO_ACTIVE_TENANT_MEMBERSHIP'
        | 'WORKSPACE_NOT_FOUND'
        | 'NO_ACTIVE_WORKSPACE_MEMBERSHIP'
    }

export interface CapabilityInput {
  readonly businessUserId: string
  readonly tenantId: string
  /** 指定时叠加该 Workspace 的成员角色能力；不指定只看租户级。 */
  readonly workspaceId?: string
}

export async function resolveCapabilities(
  reader: Reader,
  input: CapabilityInput,
): Promise<CapabilityResolution> {
  const user = await reader.businessUser.findUnique({
    where: { id: input.businessUserId },
    select: { status: true },
  })
  if (user === null) return { ok: false, reason: 'USER_NOT_FOUND' }
  if (user.status === 'DISABLED') return { ok: false, reason: 'USER_DISABLED' }

  const tenantMembership = await reader.tenantMembership.findUnique({
    where: {
      tenantId_businessUserId: {
        tenantId: input.tenantId,
        businessUserId: input.businessUserId,
      },
    },
    select: {
      status: true,
      tenantRole: {
        select: { permissions: { select: { permission: { select: { code: true } } } } },
      },
    },
  })
  if (tenantMembership === null || tenantMembership.status !== 'ACTIVE') {
    return { ok: false, reason: 'NO_ACTIVE_TENANT_MEMBERSHIP' }
  }

  const capabilities = new Set<string>()
  for (const binding of tenantMembership.tenantRole?.permissions ?? []) {
    capabilities.add(binding.permission.code)
  }

  if (input.workspaceId !== undefined) {
    const workspaceMembership = await reader.workspaceMembership.findUnique({
      where: {
        workspaceId_businessUserId: {
          workspaceId: input.workspaceId,
          businessUserId: input.businessUserId,
        },
      },
      select: {
        workspace: { select: { tenantId: true } },
        status: true,
        role: { select: { permissions: { select: { permission: { select: { code: true } } } } } },
      },
    })
    if (workspaceMembership === null || workspaceMembership.workspace.tenantId !== input.tenantId) {
      return { ok: false, reason: 'WORKSPACE_NOT_FOUND' }
    }
    if (workspaceMembership.status !== 'ACTIVE') {
      return { ok: false, reason: 'NO_ACTIVE_WORKSPACE_MEMBERSHIP' }
    }
    for (const binding of workspaceMembership.role?.permissions ?? []) {
      capabilities.add(binding.permission.code)
    }
  }

  return { ok: true, capabilities }
}
