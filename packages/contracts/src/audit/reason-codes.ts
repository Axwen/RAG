/**
 * 领域审计原因码注册表（ADR-0040 决策 3，T11a）。
 *
 * 全仓唯一的原因码来源。库里出现未注册的 `reasonCode` 是缺陷而不是灵活性：各域票据
 * 新增码就往这张表加一行，不在业务模块私拍字符串——预算模块拍一套、授权模块再拍一套，
 * 读侧就再也没法「查这个租户所有 DENIED」。
 *
 * 形状照 ../errors.ts 的 `ERROR_STATUS` 写：frozen 对象 + 从它派生查找，不在别处另写
 * 一份 switch。一处故意的分歧是联合类型从对象推导而不是独立声明（`ERROR_STATUS` 先声明
 * `ErrorCode` 再注解 `Record`），因此新增一个码只改一处，不会出现「类型里有、表里没有」。
 * 用 `satisfies` 而不是类型注解：注解会把键擦成 `string`，`keyof` 就推不出联合。
 *
 * 本文件无实现、无依赖。审计写入口在 `packages/database/src/audit/`，它 import 这里，
 * 反向不成立（T11a 审计写入口契约）。
 */

/**
 * 审计分域。与 Prisma 的 `AuditCategory` 枚举逐值一致，但**不** import 生成类型：
 * 领域契约不依赖数据库产物（T11a 范围第一条）。两处漂移由 `packages/database` 的
 * schema 文本断言钉住，不靠评审记得。
 */
export const auditCategories = [
  'BUDGET',
  'AUTHZ',
  'MEMBERSHIP',
  'DATA_CLASS',
  'INJECTION',
  'EVIDENCE',
  'DELETION',
] as const

export type AuditCategory = (typeof auditCategories)[number]

/** 判定结果。域内语义不同但读侧口径统一，便于「查这个租户所有 `DENIED`」。 */
export const auditOutcomes = ['ALLOWED', 'DENIED', 'DEGRADED', 'RECLAIMED'] as const

export type AuditOutcome = (typeof auditOutcomes)[number]

/**
 * 原因码 -> 分域。追加新域时保持命名空间与 ADR-0040 决策 3 一致：
 * `authz.*` / `membership.*` / `dataclass.*` / `injection.*` / `evidence.*` / `deletion.*`。
 *
 * 首个接入面是 T12a 的四类预算判定，`category` 一律 `BUDGET`（T12 事务入口契约的表）。
 */
export const REASON_CODES = Object.freeze({
  'budget.reserve_rejected': 'BUDGET',
  'budget.pool_boundary_rejected': 'BUDGET',
  'budget.settlement_delta': 'BUDGET',
  'budget.lease_expired': 'BUDGET',
}) satisfies Readonly<Record<string, AuditCategory>>

/** 未注册的码在编译期就过不去——与 `ERROR_STATUS` 双射同一个思路。 */
export type ReasonCode = keyof typeof REASON_CODES

/**
 * 命名空间格式：`<域>.<事件>`，两段都是 lower_snake。
 *
 * 与迁移 `20260903132723_t12a_budget_ledger_and_domain_audit` 的 CHECK
 * `domain_audit_event_reason_code_namespaced` 是同一个正则，故意留两处：库层那条兜住
 * 绕过 TS 的写入路径（裸 SQL、psql），这条兜住往上面表里新增码时手滑写成 camelCase——
 * 后者编译期是合法的对象键，只有库会在运行时拒绝，而那时已经在生产路径上了。
 */
export const REASON_CODE_PATTERN = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/

/**
 * 运行时判定一个字符串是否已注册。
 *
 * 类型系统只管住 TypeScript 调用方；审计写入口还要挡住 `as` 断言与纯 JS 调用，
 * 所以边界上必须有一次运行时检查（写入口用它做 fail closed 的那一跳）。
 */
export function isReasonCode(value: string): value is ReasonCode {
  return Object.prototype.hasOwnProperty.call(REASON_CODES, value)
}

/**
 * 写入口用它填 `category` 列，调用方不传：否则可以写出 `category=AUTHZ` +
 * `reasonCode=budget.*` 这种自相矛盾的行。列仍然存在，因为读侧要按它翻页和建索引——
 * 它是这张表映射的反范式化。
 *
 * 表里不记 `outcome`：同一个码在不同调用点可能是 `DENIED` 也可能是 `DEGRADED`
 * （数据等级阻断与降级共用一族码），`outcome` 由调用方按各域票据的表传。
 */
export function categoryForReasonCode(code: ReasonCode): AuditCategory {
  return REASON_CODES[code]
}
