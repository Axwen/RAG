import { z } from 'zod'

/**
 * 阶段 1 资源与预算硬边界的配置 schema。
 *
 * 数值来自 ADR-0025（Worker Profile 隔离）与 ADR-0029（模型预算账本）。
 * T0 只负责让这些边界成为可校验配置；运行时强制分别由 T10（Worker 并发、
 * in-flight、prefetch、RSS）和 T12（限流、预算熔断）落地。
 */
export const workerProfileNames = ['ingestion', 'evaluation'] as const
export type WorkerProfileName = (typeof workerProfileNames)[number]

const positiveInt = z.coerce.number().int().positive()

/** ingestion Profile：并发 4 / in-flight 8 / parse prefetch 1 / projection prefetch 4。 */
export const ingestionProfileSchema = z.object({
  concurrency: positiveInt.max(4),
  inFlight: positiveInt.max(8),
  parsePrefetch: positiveInt.max(1),
  projectionPrefetch: positiveInt.max(4),
})

/** evaluation Profile：并发 1 / in-flight 1，独立队列与独立预算池。 */
export const evaluationProfileSchema = z.object({
  concurrency: positiveInt.max(1),
  inFlight: positiveInt.max(1),
})

/** 单次 5 元、每日 16 元、每月 500 元（交互 350 / 评测 100 / 应急 50）。 */
export const budgetLimitsSchema = z
  .object({
    singleCallCny: z.coerce.number().positive().max(5),
    dailyCny: z.coerce.number().positive().max(16),
    monthlyCny: z.coerce.number().positive().max(500),
  })
  .refine((v) => v.singleCallCny <= v.dailyCny && v.dailyCny <= v.monthlyCny, {
    message: '预算上限必须满足 单次 <= 每日 <= 每月',
  })

/** OpenSearch 查询预算：fan-out <= 2 个知识空间，候选 <= 1024，请求超时 250 ms。 */
export const retrievalBudgetSchema = z.object({
  maxKnowledgeSpaceFanOut: positiveInt.max(2),
  candidateBudget: positiveInt.max(1024),
  requestTimeoutMs: positiveInt.max(250),
  /** 权威复核 P95 预算，位于 250 ms 请求预算之外。 */
  aclRecheckP95BudgetMs: positiveInt.max(60),
})

export const resourceLimitsSchema = z.object({
  workerProfile: z.enum(workerProfileNames),
  ingestion: ingestionProfileSchema,
  evaluation: evaluationProfileSchema,
  budget: budgetLimitsSchema,
  retrieval: retrievalBudgetSchema,
})

export type ResourceLimits = z.infer<typeof resourceLimitsSchema>

/** 阶段 1 冻结默认值。任何放宽都必须先改 ADR，再改此处。 */
export const resourceLimitsDefaults: ResourceLimits = {
  workerProfile: 'ingestion',
  ingestion: { concurrency: 4, inFlight: 8, parsePrefetch: 1, projectionPrefetch: 4 },
  evaluation: { concurrency: 1, inFlight: 1 },
  budget: { singleCallCny: 5, dailyCny: 16, monthlyCny: 500 },
  retrieval: {
    maxKnowledgeSpaceFanOut: 2,
    candidateBudget: 1024,
    requestTimeoutMs: 250,
    aclRecheckP95BudgetMs: 60,
  },
}

/** 校验一份资源边界配置；失败即抛出，调用方不得吞掉错误后继续启动。 */
export function parseResourceLimits(input: unknown): ResourceLimits {
  return resourceLimitsSchema.parse(input)
}
