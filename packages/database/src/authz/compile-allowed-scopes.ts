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
 * 阶段 1 的推导：ACTIVE 租户成员关系 → 该租户全部知识空间的键。
 * Workspace 成员关系不改变数据作用域（工作台是能力/角色边界，不是数据
 * 边界；知识空间与 Workspace 的绑定是未来扩展点，届时按 ADR-0039 决策 3
 * 逐 Workspace 推导，不得跨 Workspace 合并）。数据等级拒绝在资源策略层，
 * 不进键。
 */

type Reader = PrismaClient | Tx

export type ScopeCompilation =
  | { readonly ok: true; readonly scopes: AllowedScopes }
  | {
      readonly ok: false
      readonly reason: 'USER_NOT_FOUND' | 'USER_DISABLED' | 'NO_ACTIVE_TENANT_MEMBERSHIP'
    }

export interface ScopeCompilationInput {
  readonly businessUserId: string
  readonly tenantId: string
}

export async function compileAllowedScopes(
  reader: Reader,
  input: ScopeCompilationInput,
): Promise<ScopeCompilation> {
  // 一次 join 取齐：用户状态、成员状态、revision、知识空间列表。
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
      tenant: { select: { aclRevision: true, knowledgeSpaces: { select: { id: true } } } },
    },
  })
  if (membership === null) return { ok: false, reason: 'NO_ACTIVE_TENANT_MEMBERSHIP' }
  if (membership.businessUser.status === 'DISABLED') return { ok: false, reason: 'USER_DISABLED' }
  if (membership.status !== 'ACTIVE') return { ok: false, reason: 'NO_ACTIVE_TENANT_MEMBERSHIP' }

  return {
    ok: true,
    scopes: {
      aclRevision: membership.tenant.aclRevision,
      scopeKeys: membership.tenant.knowledgeSpaces.map((space) =>
        scopeKeyForKnowledgeSpace(input.tenantId, space.id),
      ),
    },
  }
}
