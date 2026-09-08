/**
 * 授权结果与作用域键（T14b / ADR-0026、ADR-0039）。
 *
 * 统一授权入口的输出契约：能力权限与资源策略两层判定收敛为一个决策，
 * 调用方不得拿到中间层自行组合（那是绕过统一入口的另一种形态）。
 *
 * 拒绝原因只有三类，与审计原因码一一对应：能力缺失、作用域不匹配、
 * 依赖不可用（fail closed）。资源策略的拒绝统一落在 `SCOPE_DENIED`：
 * 阶段 1 的授权模型是纯作用域型（ADR-0026），资源策略的输出就是
 * 「资源是否在允许作用域内」。
 */

/** 拒绝原因。对应审计码 authz.capability_denied / authz.scope_denied / authz.dependency_unavailable。 */
export type AuthorizationDenialReason = 'CAPABILITY_MISSING' | 'SCOPE_DENIED' | 'DEPENDENCY_UNAVAILABLE'

/** 统一授权入口的判定结果。允许时无附加载荷：能力明细不外发，判定本身即契约。 */
export type AuthorizationDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: AuthorizationDenialReason }

/** 授权请求的五元输入（ADR-0039 决策 2）。 */
export interface AuthorizationRequest {
  readonly businessUserId: string
  readonly tenantId: string
  /** 可选：指定 Workspace 时叠加该 Workspace 成员角色的能力（不指定则只看租户级）。 */
  readonly workspaceId?: string
  /** 能力权限码（permissions.code），只判「能否执行操作」。 */
  readonly capability: string
  /**
   * 可选资源。给定时走资源策略层（作用域判定 + 数据等级拒绝）；不给定时
   * 只做能力判定——「无资源的能力检查」是合法的（如进入工作台）。
   */
  readonly resource?: AuthorizationResource
}

/** 阶段 1 参与资源策略的资源类型：知识空间与文档版本（其余域按 ADR-0039 扩展点处理）。 */
export type AuthorizationResource =
  | { readonly kind: 'knowledge_space'; readonly knowledgeSpaceId: string }
  | { readonly kind: 'document_version'; readonly knowledgeSpaceId: string; readonly documentVersionId: string }

/**
 * `acl_scope_key`（ADR-0026/0037）：索引侧与查询侧共用的稳定过滤键。
 *
 * 编码由本函数统一定义（ADR-0037：应用层统一生成和解析，它是过滤键不是
 * 主体列表）。阶段 1 的键粒度是租户 + 知识空间：文档投影按所属知识空间
 * 落键，主体按成员关系解析出允许的键集合，OpenSearch filter 做 IN 匹配。
 * 数据等级与可见性在需要参与作用域判定时由 PostgreSQL 编码进键（阶段 1
 * 的数据等级拒绝在资源策略层做，不进键）。
 *
 * 格式刻意可解析（`parseScopeKey`）：T5 索引投影与 T6 查询编译两侧都要
 * 能从键还原出租户与知识空间，调试时也需要人读。
 */
const SCOPE_KEY_PATTERN = /^t:([0-9a-f-]{36}):ks:([0-9a-f-]{36})$/

export function scopeKeyForKnowledgeSpace(tenantId: string, knowledgeSpaceId: string): string {
  return `t:${tenantId}:ks:${knowledgeSpaceId}`
}

export interface ParsedScopeKey {
  readonly tenantId: string
  readonly knowledgeSpaceId: string
}

/** 解析作用域键。非本格式返回 undefined——未知键不是错误，是不匹配。 */
export function parseScopeKey(key: string): ParsedScopeKey | undefined {
  const match = SCOPE_KEY_PATTERN.exec(key)
  if (match === null) return undefined
  return { tenantId: match[1]!, knowledgeSpaceId: match[2]! }
}

/**
 * 主体侧允许的作用域集合（ADR-0026 第一段授权的输出）。
 *
 * `aclRevision` 是租户级授权事实版本：撤权或成员变更时递增，Redis 缓存键
 * 必须包含它（不依赖 TTL 失效）。携带在结果里而不是单独查询，保证「集合
 * 与版本」来自同一次读取。
 */
export interface AllowedScopes {
  readonly scopeKeys: readonly string[]
  readonly aclRevision: number
}

/**
 * 候选权威复核的判定（ADR-0026 第二段授权）。
 *
 * 复核只能做减法：`rejected` 的候选被丢弃且不进入证据、引用与 Trace 摘要。
 * 拒绝原因目前只有一类（候选不存在或不在本租户的作用域内）；删除墓碑、
 * Legal Hold 与有效期随 T5/T8 的列落地逐项加入，形状保持批量单查询。
 */
export interface CandidateRecheckResult {
  readonly allowed: readonly string[]
  readonly rejected: readonly string[]
}
