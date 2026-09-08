import { scopeKeyForKnowledgeSpace, type AllowedScopes } from '@rag/contracts'
import type { PrismaClient } from '../generated/prisma/client'
import type { Tx } from '../tx'

/**
 * 允许作用域编译（T14b / ADR-0026 第一段授权）。
 *
 * 把当前主体解析为允许的 `acl_scope_key` 集合与当前 `aclRevision`，供
 * 查询链路编译进 BM25 与向量查询的 filter（`acl_scope_key IN …`，实际
 * 接线归 T6）。集合与版本必须来自同一次读取——分两次查会出现「集合是
 * 旧版本、revision 是新版本」的错配，缓存就压不住失效窗口。
 *
 * 阶段 1 的推导：未指定 Workspace 时，ACTIVE 租户成员关系 → 该租户全部
 * 知识空间的键；指定 Workspace 时，还必须具备 ACTIVE Workspace 成员关系，
 * 且只返回该 Workspace 显式绑定的知识空间。切换 Workspace 不继承上一个
 * Workspace 的资源范围（ADR-0039 决策 3）。数据等级拒绝在资源策略层，不进键。
 *
 * 与 resolveCapabilities 的分工：那边先查用户再查成员（要区分
 * USER_NOT_FOUND），这边一次 join 取齐——统一授权入口先过能力层，走到
 * 作用域编译时用户必然已存在，失败口径收窄到 USER_DISABLED /
 * NO_ACTIVE_TENANT_MEMBERSHIP 两类，两者都是 resolveCapabilities 失败
 * 原因的子集（类型断言钉在 authz-entries.test.ts，防止两处口径漂移）。
 */

type Reader = PrismaClient | Tx

export type ScopeCompilation =
  | { readonly ok: true; readonly scopes: AllowedScopes }
  | {
      readonly ok: false
      readonly reason:
        'USER_DISABLED' | 'NO_ACTIVE_TENANT_MEMBERSHIP' | 'NO_ACTIVE_WORKSPACE_MEMBERSHIP'
    }

export interface ScopeCompilationInput {
  readonly businessUserId: string
  readonly tenantId: string
  readonly workspaceId?: string
}

export async function compileAllowedScopes(
  reader: Reader,
  input: ScopeCompilationInput,
): Promise<ScopeCompilation> {
  // 一次 join 取齐：用户状态、两层成员状态、revision、知识空间绑定。
  const membership = await reader.tenantMembership.findUnique({
    where: {
      tenantId_businessUserId: {
        tenantId: input.tenantId,
        businessUserId: input.businessUserId,
      },
    },
    select: {
      status: true,
      businessUser: { select: { status: true } },
      tenant: {
        select: {
          aclRevision: true,
          knowledgeSpaces: { select: { id: true } },
          workspaces: {
            where: input.workspaceId === undefined ? { id: { in: [] } } : { id: input.workspaceId },
            select: {
              members: {
                where: { businessUserId: input.businessUserId, status: 'ACTIVE' },
                select: { id: true },
              },
              knowledgeSpaces: { select: { knowledgeSpaceId: true } },
            },
          },
        },
      },
    },
  })
  if (membership === null) return { ok: false, reason: 'NO_ACTIVE_TENANT_MEMBERSHIP' }
  if (membership.businessUser.status === 'DISABLED') return { ok: false, reason: 'USER_DISABLED' }
  if (membership.status !== 'ACTIVE') return { ok: false, reason: 'NO_ACTIVE_TENANT_MEMBERSHIP' }

  let knowledgeSpaceIds: readonly string[]
  if (input.workspaceId === undefined) {
    knowledgeSpaceIds = membership.tenant.knowledgeSpaces.map((space) => space.id)
  } else {
    const workspace = membership.tenant.workspaces[0]
    if (workspace === undefined || workspace.members.length === 0) {
      return { ok: false, reason: 'NO_ACTIVE_WORKSPACE_MEMBERSHIP' }
    }
    knowledgeSpaceIds = workspace.knowledgeSpaces.map((binding) => binding.knowledgeSpaceId)
  }

  return {
    ok: true,
    scopes: {
      aclRevision: membership.tenant.aclRevision,
      scopeKeys: knowledgeSpaceIds.map((knowledgeSpaceId) =>
        scopeKeyForKnowledgeSpace(input.tenantId, knowledgeSpaceId),
      ),
    },
  }
}
