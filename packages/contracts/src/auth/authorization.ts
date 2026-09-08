import type { ReasonCode } from '../audit/reason-codes'

/**
 * 授权结果与作用域键（T14b / ADR-0026、ADR-0039）。
 *
 * 统一授权入口的输出契约：能力权限与资源策略两层判定收敛为一个决策，
 * 调用方不得拿到中间层自行组合（那是绕过统一入口的另一种形态）。
 *
 * 拒绝原因有四类，与审计原因码一一对应：能力缺失、作用域不匹配、
 * 数据等级拒绝、依赖不可用（fail closed）。作用域不匹配与数据等级拒绝
 * 同属资源策略层（ADR-0039 决策 2），但分开记：两者的补救路径完全
 * 不同（成员关系 vs 重新定级），审计读侧要能按原因码区分。
 */

/** 拒绝原因。对应审计码 authz.capability_denied / authz.scope_denied /
 * authz.dataclass_denied / authz.dependency_unavailable。 */
export type AuthorizationDenialReason =
  'CAPABILITY_MISSING' | 'SCOPE_DENIED' | 'DATA_CLASS_DENIED' | 'DEPENDENCY_UNAVAILABLE'

/** 统一授权入口的审计原因码：中央注册表 `authz.*` 命名空间的收窄视图。
 * 拒绝原因与审计码一一对应，这里钉住「服务层不再私拍联合类型」——
 * 注册表加码而本视图跟不上，编译期就过不去。 */
export type AuthzReasonCode = Extract<ReasonCode, `authz.${string}`>

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
  | {
      readonly kind: 'document_version'
      readonly knowledgeSpaceId: string
      readonly documentVersionId: string
    }

/**
 * 文档版本数据等级。与 Prisma 的 `DataClass` 枚举逐值一致——契约不
 * import 生成类型，两处各写一份，漂移由 `packages/database` 的 schema
 * 文本断言钉住（与 `auditCategories` 同一模式，ADR-0040 决策 3 的先例）。
 */
export const documentVersionDataClasses = [
  'UNKNOWN',
  'PUBLIC',
  'INTERNAL',
  'CONTROLLED',
  'SENSITIVE',
] as const

export type DocumentVersionDataClass = (typeof documentVersionDataClasses)[number]

/**
 * 阶段 1 资源策略直接拒绝的数据等级（ADR-0039 决策 2、ADR-0025）。
 *
 * 阶段 1 没有 per-subject 的 clearance 模型，统一授权入口对
 * document_version 采取 fail-closed 默认：UNKNOWN（无法定级）与
 * SENSITIVE（敏感级）拒绝，其余放行。引入 clearance 后此集合变为
 * per-subject 计算，那是新 ADR 的事。
 *
 * 边界要读清楚：这只是**直连资源访问**的判定。检索链路的候选复核
 * 不做这个减法——SENSITIVE 候选仍要被召回，由 ModelAdapter 准入层按
 * 执行区阻断（ADR-0025）；把拒绝塞进复核会让敏感内容失去进入本地
 * 执行区的路由机会。
 */
export const stage1DeniedDataClasses: readonly DocumentVersionDataClass[] = ['UNKNOWN', 'SENSITIVE']

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
 * 数据等级**不是**复核的减法项——`dataClasses` 是给统一授权入口资源
 * 策略读的元数据，检索链路忽略它（SENSITIVE 候选的路由阻断在 T15
 * 准入层，见 `stage1DeniedDataClasses` 的边界说明）。
 */
export interface CandidateRecheckResult {
  readonly allowed: readonly string[]
  readonly rejected: readonly string[]
  /** 允许候选的 dataClass，按 documentVersionId 索引；拒绝候选不出现。 */
  readonly dataClasses: Readonly<Record<string, DocumentVersionDataClass>>
}
