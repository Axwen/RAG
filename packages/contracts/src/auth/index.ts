/**
 * 服务端身份上下文（T14a / ADR-0039）。
 *
 * 这里只有「知道你是谁」的事实：业务用户、租户成员与 Workspace 成员及其
 * 角色。「你能做什么」是 T14b 统一授权入口的输出（能力权限判定 + 资源
 * 策略），不在本包预演——现在把能力码放进上下文，等于让调用方绕过统一
 * 授权入口自己判定，那正是 ADR-0039 要消灭的形态。
 *
 * 不暴露 Keycloak 管理模型（ADR-0039 决策 1）：issuer/subject 是 OIDC
 * 标准声明、也是本系统与外部身份的唯一映射键，属于领域事实；Realm、
 * Client、Keycloak Role/Group 一概不进契约。可变 email 只作展示。
 */

/** 成员关系状态。与 Prisma MembershipStatus 字面量一致，漂移由测试钉住。 */
export type MembershipStatus = 'ACTIVE' | 'SUSPENDED' | 'REVOKED'

/** 业务用户状态。DISABLED 由业务库记录，不依赖 Keycloak 侧禁用。 */
export type BusinessUserStatus = 'ACTIVE' | 'DISABLED'

/** 角色引用：身份上下文只需要标识与稳定 code，不携带权限展开。 */
export interface IdentityRoleRef {
  readonly id: string
  readonly code: string
  readonly name: string
}

/** 租户成员事实。tenantRole 为 null 表示普通成员（无租户级管理角色）。 */
export interface TenantMembershipContext {
  readonly tenantId: string
  readonly status: MembershipStatus
  readonly tenantRole: IdentityRoleRef | null
}

/**
 * Workspace 成员事实。tenantId 随 Workspace 携带：切换 Workspace 不继承
 * 上一 Workspace 的资源范围（ADR-0039 决策 3），装配时必须按 Workspace
 * 分别取角色，不得跨 Workspace 合并。
 */
export interface WorkspaceMembershipContext {
  readonly tenantId: string
  readonly workspaceId: string
  readonly slug: string
  readonly name: string
  readonly status: MembershipStatus
  readonly role: IdentityRoleRef | null
}

/**
 * 服务端身份上下文：由「已验证的 (issuer, subject)」加上业务库的成员
 * 事实装配而成。租户上下文只从这里推导，不信任请求体（决策 4）。
 * SUSPENDED/REVOKED 的成员关系照实携带——它们是身份事实；「能不能用」
 * 由 T14b 的授权入口判定，而不是在装配时静默丢弃。
 */
export interface ServerIdentityContext {
  readonly businessUserId: string
  readonly issuer: string
  readonly subject: string
  readonly displayName: string
  readonly email: string | null
  readonly userStatus: BusinessUserStatus
  readonly tenantMemberships: readonly TenantMembershipContext[]
  readonly workspaceMemberships: readonly WorkspaceMembershipContext[]
}

/**
 * 会话视图：/auth/session 返回给前端的投影。不携带 issuer/subject——
 * 它们是服务端映射键，前端展示不需要，也不必随每个会话响应外发。
 */
export interface SessionView {
  readonly businessUserId: string
  readonly displayName: string
  readonly email: string | null
  readonly activeTenantId: string | null
  readonly tenants: ReadonlyArray<{
    readonly tenantId: string
    readonly tenantRoleCode: string | null
  }>
  readonly workspaces: ReadonlyArray<{
    readonly tenantId: string
    readonly workspaceId: string
    readonly slug: string
    readonly name: string
    readonly roleCode: string | null
  }>
}

/** 由完整上下文投影出会话视图（唯一构造点，投影规则不散落各端点）。 */
export function toSessionView(
  context: ServerIdentityContext,
  activeTenantId?: string,
): SessionView {
  return {
    businessUserId: context.businessUserId,
    displayName: context.displayName,
    email: context.email,
    activeTenantId: activeTenantId ?? null,
    tenants: context.tenantMemberships.map((m) => ({
      tenantId: m.tenantId,
      tenantRoleCode: m.tenantRole?.code ?? null,
    })),
    workspaces: context.workspaceMemberships.map((m) => ({
      tenantId: m.tenantId,
      workspaceId: m.workspaceId,
      slug: m.slug,
      name: m.name,
      roleCode: m.role?.code ?? null,
    })),
  }
}
export * from './authorization'
