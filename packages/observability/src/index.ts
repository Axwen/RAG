/**
 * 可观测性共享包。
 *
 * T0 只提供强制脱敏的结构化日志入口。指标与追踪按票据加入：
 * - T3：Outbox 与事件投递指标
 * - T10：Worker Profile 资源指标与 RSS 警戒
 * - T11b：Trace 入口与指标注册（遥测走 Outbox，丢失不影响业务）
 * - T12b：限流与用量指标
 *
 * 本包**不提供领域审计写入口**。审计与遥测按 ADR-0040 分在两个包上：审计写入口只在
 * `packages/database`，必须传入已开启的事务，写失败即业务回滚；遥测在本包与
 * `apps/api/src/modules/telemetry/`，失败必须被吞。曾经写在这里的「T14：授权判定与
 * 拒绝原因码审计」是把两条载体混进一个包的口径，已按 ADR-0040 决策 1 移除——授权拒绝
 * 的原因码登记在 `packages/contracts/src/audit/`，写入走审计入口，不经过本包。
 */
export const OBSERVABILITY_PACKAGE = '@rag/observability' as const

export * from './health'
export * from './logger'
export * from './redaction'
