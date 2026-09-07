import type { ServerIdentityContext } from '@rag/contracts'
import type { Tx } from '../tx'

/**
 * 按外部身份装配服务端身份上下文（T14a / ADR-0039 决策 1、3）。
 *
 * 这是 auth 模块到业务库的唯一身份读入口：一次查询取回业务用户与全部成员
 * 事实（租户成员 + Workspace 成员，含角色引用），不提供逐表散查的捷径——
 * 散查会让「装配时必须按 Workspace 分别取角色」这条约束散落到调用方。
 *
 * 两个刻意不做的事：
 * - **不自动建用户（JIT provisioning）。** 未经管理员建立的 (issuer, subject)
 *   进来只是零成员的空身份，自动建档等于把「谁能成为业务用户」的决定权交给
 *   IdP 侧的注册开关。阶段 1 用户由种子/管理面建立，JIT 属产品决策，留待
 *   显式票据。
 * - **不在这一层过滤成员状态。** SUSPENDED/REVOKED 照实装进上下文（契约注
 *   释里写明的原因）：它们是身份事实，「能不能用」由 T14b 授权入口判定。
 *   唯一在这里终止的是用户级 DISABLED——禁用用户不存在「部分可用」。
 */

/** 装配失败的两种原因；调用方映射 UNAUTHORIZED，不区分对客户端的文案。 */
export type IdentityLookupResult =
  | { readonly ok: true; readonly context: ServerIdentityContext }
  | { readonly ok: false; readonly reason: 'USER_NOT_FOUND' | 'USER_DISABLED' }

export interface IdentityLookupInput {
  /** OIDC iss 声明，形如 https://keycloak:8443/realms/rag-local。 */
  readonly issuer: string
  /** OIDC sub 声明，Keycloak 用户 id。两者合起来是唯一映射键。 */
  readonly subject: string
}

export async function loadIdentityContext(
  tx: Tx,
  input: IdentityLookupInput,
): Promise<IdentityLookupResult> {
  const user = await tx.businessUser.findUnique({
    where: { issuer_subject: { issuer: input.issuer, subject: input.subject } },
    include: {
      tenantMemberships: { include: { tenantRole: true } },
      workspaceMemberships: { include: { workspace: true, role: true } },
    },
  })
  if (user === null) return { ok: false, reason: 'USER_NOT_FOUND' }
  if (user.status === 'DISABLED') return { ok: false, reason: 'USER_DISABLED' }

  return {
    ok: true,
    context: {
      businessUserId: user.id,
      issuer: user.issuer,
      subject: user.subject,
      displayName: user.displayName,
      email: user.email,
      userStatus: user.status,
      tenantMemberships: user.tenantMemberships.map((m) => ({
        tenantId: m.tenantId,
        status: m.status,
        tenantRole:
          m.tenantRole === null
            ? null
            : { id: m.tenantRole.id, code: m.tenantRole.code, name: m.tenantRole.name },
      })),
      workspaceMemberships: user.workspaceMemberships.map((m) => ({
        tenantId: m.workspace.tenantId,
        workspaceId: m.workspaceId,
        slug: m.workspace.slug,
        name: m.workspace.name,
        status: m.status,
        role: m.role === null ? null : { id: m.role.id, code: m.role.code, name: m.role.name },
      })),
    },
  }
}
