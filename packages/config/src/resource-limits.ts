import { z } from 'zod'

/**
 * 阶段 1 资源与预算硬边界的配置 schema。
 *
 * 数值来自 ADR-0025（Worker Profile 隔离）、ADR-0029（模型预算账本）与
 * ADR-0034（用户级限流与并发配额）。T0 只负责让这些边界成为可校验配置；运行时强制
 * 分别由 T10（Worker 并发、in-flight、prefetch、RSS）和 T12（限流、预算熔断）落地。
 * 单价与汇率不在本文件，见 `./model-pricing`：那是价目而不是边界。
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

/**
 * 预算池三分（ADR-0029）：交互 350 / 评测 100 / 应急保留 50。
 *
 * 这里用小写（与 `workerProfileNames` 同风格），Prisma 侧的枚举是
 * `INTERACTIVE`/`EVALUATION`/`RESERVE`（见 T12 票据事务入口契约的 `type Pool`）。
 * 两处是同一组池，大小写差异只是各自语言的既有约定。
 */
export const budgetPoolNames = ['interactive', 'evaluation', 'reserve'] as const
export type BudgetPoolName = (typeof budgetPoolNames)[number]

const cnyAmount = z.coerce.number().positive()

/** 池上限与 5/16/500 同属 ADR-0029 的上限口径，因此也是代码里的上界：调大要先改 ADR。 */
export const budgetPoolLimitsSchema = z.object({
  interactive: cnyAmount.max(350),
  evaluation: cnyAmount.max(100),
  reserve: cnyAmount.max(50),
})

/**
 * 预扣 lease。ADR-0029 定默认 60 秒，长调用必须显式续租。
 *
 * 续租上限用「总时长」而不是「续租次数」：次数要在账本上多一列计数，总时长只用已有的
 * 创建时间。`renewBudgetLease` 把 `leaseExpiresAt` 推过 `maxTotalSeconds` 时返回
 * `RENEW_LIMIT_EXCEEDED`（见 T12 票据事务入口契约）。
 *
 * 三个上界都是初始值可校准，但 `defaultSeconds` 的上界存在本身不可去掉：它就是
 * 「不得靠调大默认值掩盖没人续租」这条不变量的落点。
 */
export const budgetLeaseSchema = z
  .object({
    defaultSeconds: positiveInt.max(300),
    maxRenewSeconds: positiveInt.max(300),
    maxTotalSeconds: positiveInt.max(1800),
  })
  .refine((v) => v.defaultSeconds <= v.maxTotalSeconds && v.maxRenewSeconds <= v.maxTotalSeconds, {
    message: 'lease 默认时长与单次续租时长都不得超过总时长上限',
  })

/** 单次 5 元、每日 16 元、每月 500 元（交互 350 / 评测 100 / 应急 50）。 */
export const budgetLimitsSchema = z
  .object({
    singleCallCny: z.coerce.number().positive().max(5),
    dailyCny: z.coerce.number().positive().max(16),
    monthlyCny: z.coerce.number().positive().max(500),
    pools: budgetPoolLimitsSchema,
    lease: budgetLeaseSchema,
  })
  .refine((v) => v.singleCallCny <= v.dailyCny && v.dailyCny <= v.monthlyCny, {
    message: '预算上限必须满足 单次 <= 每日 <= 每月',
  })
  .refine((v) => v.dailyCny * 31 <= v.monthlyCny, {
    /** ADR-0029 修的正是这处不自洽：原口径每日 20 × 30 天 = 600 元 > 月度 500 元。
     *  按 31 天算（月份最长值），16 × 31 = 496 <= 500 才自洽。 */
    message: '每日上限 × 31 天不得超过月度上限',
  })
  .refine(
    (v) =>
      Number((v.pools.interactive + v.pools.evaluation + v.pools.reserve).toFixed(6)) ===
      Number(v.monthlyCny.toFixed(6)),
    {
      /** 要求相等而不是「不超过」：小于会留下任何池都花不掉的额度，大于则池加起来能突破
       *  月度硬上限。取到 6 位小数再比，与账本列 `@db.Decimal(12, 6)` 同一精度，
       *  避免把浮点尾差判成配置错误。 */
      message: '三个池之和必须等于月度上限',
    },
  )

/**
 * 用户级配额（ADR-0034）：并发 AnswerRun 1、并发 SSE 2、提问 10 次/分与 200 次/日、
 * 上传 20 文件/小时。
 *
 * 这五个值（含下面管理侧的 rebuild）与 5/16/500 性质不同：ADR-0034 明确它们是初始值，
 * 「必须在 PROBE-005 与首轮批量评测得到真实时延和单次成本后校准，校准结果写入运行配置
 * 而不是重开 ADR」。所以 ADR 的数值落在**默认值**上，`.max()` 只挡明显打错的量级
 * （并发 1 敲成 1000），不是政策上界——否则校准就得改代码。
 *
 * 下面六个 `.max()` 的具体数值不是本文件自己定的：见 ADR-0034 的
 * 「2026-09-04 补充：配置 schema 的安全上界」。写进 ADR 是因为一个只活在代码注释里的上界，
 * 读 ADR 的人会以为「可按租户覆盖」是无界的，等运行配置真写了 200 次/分钟被启动校验拒绝时，
 * 找不到依据。那一节也记了为什么这些上界挡不住任何真实校准值（按 ADR-0029 的实测成本，
 * 每日 16 元在 5000 次之前早就先耗尽了）。改这里的任何一个数就要同时改那一节。
 */
export const userQuotaSchema = z
  .object({
    concurrentAnswerRuns: positiveInt.max(8),
    concurrentSseConnections: positiveInt.max(16),
    questionsPerMinute: positiveInt.max(120),
    questionsPerDay: positiveInt.max(5000),
    uploadsPerHour: positiveInt.max(500),
  })
  .refine((v) => v.questionsPerMinute <= v.questionsPerDay, {
    message: '每日提问上限不得小于每分钟上限',
  })

/** 管理侧配额：`rebuild` 每租户并发 1（ADR-0034 末段）。同样是可校准初始值。 */
export const adminQuotaSchema = z.object({
  concurrentRebuildsPerTenant: positiveInt.max(4),
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
  userQuota: userQuotaSchema,
  adminQuota: adminQuotaSchema,
})

export type ResourceLimits = z.infer<typeof resourceLimitsSchema>

/** 阶段 1 冻结默认值。任何放宽都必须先改 ADR，再改此处。 */
export const resourceLimitsDefaults: ResourceLimits = {
  workerProfile: 'ingestion',
  ingestion: { concurrency: 4, inFlight: 8, parsePrefetch: 1, projectionPrefetch: 4 },
  evaluation: { concurrency: 1, inFlight: 1 },
  budget: {
    singleCallCny: 5,
    dailyCny: 16,
    monthlyCny: 500,
    pools: { interactive: 350, evaluation: 100, reserve: 50 },
    lease: { defaultSeconds: 60, maxRenewSeconds: 60, maxTotalSeconds: 600 },
  },
  retrieval: {
    maxKnowledgeSpaceFanOut: 2,
    candidateBudget: 1024,
    requestTimeoutMs: 250,
    aclRecheckP95BudgetMs: 60,
  },
  userQuota: {
    concurrentAnswerRuns: 1,
    concurrentSseConnections: 2,
    questionsPerMinute: 10,
    questionsPerDay: 200,
    uploadsPerHour: 20,
  },
  adminQuota: { concurrentRebuildsPerTenant: 1 },
}

/** 校验一份资源边界配置；失败即抛出，调用方不得吞掉错误后继续启动。 */
export function parseResourceLimits(input: unknown): ResourceLimits {
  return resourceLimitsSchema.parse(input)
}
