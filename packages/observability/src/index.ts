/**
 * 可观测性共享包。
 *
 * T0 只提供强制脱敏的结构化日志入口。指标、追踪与审计事件按票据加入：
 * - T3：Outbox 与事件投递指标
 * - T10：Worker Profile 资源指标与 RSS 警戒
 * - T12：限流、预算熔断与用量事实
 * - T14：授权判定与拒绝原因码审计
 */
export const OBSERVABILITY_PACKAGE = '@rag/observability' as const

export * from './health'
export * from './logger'
export * from './redaction'
