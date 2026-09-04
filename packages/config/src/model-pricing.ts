import { z } from 'zod'

/**
 * 模型单价、汇率与预扣估值。
 *
 * 单价与汇率来自 PROBE-005 的 LIVE 报文反算（供应商自己返回的 `usage.cost`），口径与
 * 冻结值见 T12 票据的「预扣估值价格表与汇率」。全表是**初始值可校准**：供应商随时调价，
 * 校准结果写运行配置，不重开 ADR——与 ADR-0034 对五个配额值的处理同一口径。
 *
 * 为什么落在 `@rag/config` 而不是 `@rag/database`：估值是价目表的纯函数，没有事务也没有
 * 表结构。放进 database 会让估值反过来依赖 Prisma；放进调用侧（`apps/api` 的 model 模块）
 * 则 Worker 侧的评测批量算不出同一个数。ADR-0029 要求结算以供应商返回的 `cost` 为准，
 * 所以这里的估值只用于**预扣**与供应商缺 `cost` 时的兜底。
 *
 * 金额一律返回「元」的 number 并按账本列的 scale（`@db.Decimal(12, 6)`）取整到 6 位小数：
 * 估值是单个值不做累加，浮点在这里安全；累加发生在 PostgreSQL 的 Decimal 列上。调用方
 * 用 `new Prisma.Decimal(...)` 包一层再写账本（见 T12 票据的事务入口契约）。
 */

/**
 * 单价一律 `.positive()`，不接受 0。
 *
 * 0 不是「免费」的合法写法，而是**配置缺失的伪装**：`z.coerce.number()` 把 `''`、`null`、`' '`、
 * `[]`、`false` 全部折成 0（zod 4.5.4 实测），而 T12b 的运行配置正是要从环境变量读这几个值。
 * 单价 0 的后果不是估值偏低一点，是那条腿的预扣恒为 0——四层 CAS 全部通过，门禁静默打开，
 * 与「预扣不能低于真实支出」直接冲突。真有免费档就写一个显式的极小值（例如 1e-6），
 * 让「免费」在配置里看得见，而不是和「忘了配」共用同一个 0。
 *
 * 与 `./resource-limits` 同一口径：那边每个数值字段（`positiveInt`、`cnyAmount`、三条预算上限）
 * 都是 `.positive()`，这里原先的 `.nonnegative()` 是全包唯一的例外。
 */
const usdPerMillionTokens = z.coerce.number().positive().max(1000)

export const modelPricingSchema = z
  .object({
    /** 汇率 CNY/USD。PROBE-005 第 222 行「汇率假设 7.2」，此处冻为默认值。
     *  ADR-0029 补充要求汇率与结算金额分开记录，否则事后分不清「用量变化」与「汇率变化」。
     *  上界 20 只挡打错一位（把 7.2 敲成 72），不是政策。 */
    cnyPerUsd: z.coerce.number().positive().max(20),
    /** `qwen/qwen3-embedding-8b`（OpenRouter）。查询腿与逐句验证腿共用。 */
    embeddingUsdPerMillionTokens: usdPerMillionTokens,
    /** `qwen/qwen3-reranker-8b`（OpenRouter）。单次问答里最大的单项。 */
    rerankerUsdPerMillionTokens: usdPerMillionTokens,
    /** fluxionai `gpt-5.6-terra` 输入（未命中前缀缓存）。 */
    chatInputUsdPerMillionTokens: usdPerMillionTokens,
    /**
     * 同一模型命中前缀缓存的输入价。PROBE-005 第 196 行 40/40 次都命中
     * `cached_tokens: 64`（system prompt 前缀），ADR-0029 因此要求输入按缓存分档，
     * 否则系统性高估输入成本。
     *
     * **默认值等于未缓存价**：该端点的缓存折扣率没有任何公开价目或实测支撑，编一个折扣
     * 会让预扣低于真实支出——那是这条门禁最贵的失败方向。等供应商公开价目或结算数据
     * 反算出折扣率，再把这一项调下来；调它不需要新 ADR。
     */
    chatCachedInputUsdPerMillionTokens: usdPerMillionTokens,
    /** fluxionai `gpt-5.6-terra` 输出。 */
    chatOutputUsdPerMillionTokens: usdPerMillionTokens,
    /**
     * rerank 每个候选的估算 token 数。不得用固定总价：ADR-0029 要求预扣估值由候选数计算。
     * 从四个 LIVE 锚点反算每候选 token 得 104 / 107 / 108 / 108（候选 8 / 64 / 256 / 1024），
     * 取 108 是取大候选档——查询本身的固定 token 在候选少时摊不薄，而大候选档正是贵的那一档。
     */
    rerankTokensPerCandidate: z.coerce.number().int().positive().max(4096),
  })
  .refine((v) => v.chatCachedInputUsdPerMillionTokens <= v.chatInputUsdPerMillionTokens, {
    message: '缓存命中价不得高于未缓存价',
  })

export type ModelPricing = z.infer<typeof modelPricingSchema>

/** PROBE-005 反算的冻结初始值。校准写运行配置，不改这里的语义。 */
export const modelPricingDefaults: ModelPricing = {
  cnyPerUsd: 7.2,
  embeddingUsdPerMillionTokens: 0.01,
  rerankerUsdPerMillionTokens: 0.2,
  chatInputUsdPerMillionTokens: 0.1,
  chatCachedInputUsdPerMillionTokens: 0.1,
  chatOutputUsdPerMillionTokens: 0.3,
  rerankTokensPerCandidate: 108,
}

/** 校验一份价目配置；失败即抛出，调用方不得吞掉错误后继续启动。 */
export function parseModelPricing(input: unknown): ModelPricing {
  return modelPricingSchema.parse(input)
}

/** 账本列是 `@db.Decimal(12, 6)`，估值在这里就取到同一精度，写账本时不会再被截一次。 */
const ledgerScale = 6

function roundToLedgerScale(cny: number): number {
  return Number(cny.toFixed(ledgerScale))
}

/**
 * 估值入参必须是有限非负整数。
 *
 * 不是防御式编程的装饰，是「预扣不能低于真实支出」在函数边界上的落点：
 * - **负数会互相抵消。** 单独一条负腿在 `reserveBudget` 会被「预扣金额为负」挡下，但
 *   `estimateAnswerRunCny` 是四条腿相加：`rerankCandidateCount: -1000` 配一条正常的 Chat 腿，
 *   总额仍是正数、只是偏低，四层 CAS 全部通过。实测 `estimateRerankCny(..., { candidateCount: -1 })`
 *   返回 `-0.000156`。
 * - **`NaN` 比负数更危险。** 它传到账本比较时 `greaterThan` 全为 false，于是每层上限都「没超」。
 *   fail closed 的唯一办法是在这里就抛。
 * - `Number.isInteger` 一次挡掉 `NaN`、`±Infinity` 与小数：token 与候选数没有半个。
 *
 * 抛而不是返回错误值：与 `reserveBudget` 的入参校验同一立场——参数写错是调用方的缺陷，
 * 不是「预算不够」这类业务结果，两者在调用侧必须长得不一样。0 合法（0 token、0 候选、0 句）。
 */
function requireCount(name: string, value: number): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(
      `估值入参 ${name} 必须是有限非负整数，收到 ${String(value)}：估值出错时不得记账`,
    )
  }
  return value
}

/**
 * `ModelPricing` 只约束形状，不保证这份价目过了 `parseModelPricing`：
 * `{ ...modelPricingDefaults, embeddingUsdPerMillionTokens: 0 }` 是合法的 `ModelPricing`。
 * 所以单价的正数约束在这里再兜一次，口径同迁移里那条 `reasonCode` 格式 CHECK——兜住绕过
 * schema 的写入路径，不复制 schema 的内容。写 `!(x > 0)` 而不是 `x <= 0`：前者连 `NaN` 一起挡。
 */
function tokensToCny(tokens: number, usdPerMillion: number, cnyPerUsd: number): number {
  if (!(usdPerMillion > 0)) {
    throw new Error(
      `模型单价必须为正，收到 ${String(usdPerMillion)}：单价 0 让这条腿的预扣恒为 0，等于关掉门禁`,
    )
  }
  if (!(cnyPerUsd > 0)) {
    throw new Error(`汇率必须为正，收到 ${String(cnyPerUsd)}：汇率 0 会把折算金额全抹成 0`)
  }
  return (tokens / 1_000_000) * usdPerMillion * cnyPerUsd
}

/** 查询腿与逐句验证腿的 Embedding 估值。 */
export function estimateEmbeddingCny(pricing: ModelPricing, input: { tokens: number }): number {
  return roundToLedgerScale(
    tokensToCny(
      requireCount('tokens', input.tokens),
      pricing.embeddingUsdPerMillionTokens,
      pricing.cnyPerUsd,
    ),
  )
}

/**
 * Rerank 估值。`candidateCount` 取自 `RetrievalManifest` 的 `rerankInputSize`，
 * 不从前端或环境变量覆盖——它是预算参数，不只是检索调优参数（ADR-0029 补充）。
 *
 * 必须在 ±5% 内复现 PROBE-005 的四个 LIVE 锚点（候选 8 / 64 / 256 / 1024 →
 * ¥0.0012 / 0.0099 / 0.0397 / 0.1587，汇率 7.2），断言见本包测试。
 */
export function estimateRerankCny(
  pricing: ModelPricing,
  input: { candidateCount: number },
): number {
  // 每候选 token 数同属价目表，也要兜一次：它是 0 时候选数再大 tokens 也是 0，
  // 与单价 0 是同一种「门禁静默打开」。
  if (
    !Number.isInteger(pricing.rerankTokensPerCandidate) ||
    pricing.rerankTokensPerCandidate <= 0
  ) {
    throw new Error(
      `rerankTokensPerCandidate 必须是正整数，收到 ${String(pricing.rerankTokensPerCandidate)}`,
    )
  }
  const tokens =
    requireCount('candidateCount', input.candidateCount) * pricing.rerankTokensPerCandidate
  return roundToLedgerScale(
    tokensToCny(tokens, pricing.rerankerUsdPerMillionTokens, pricing.cnyPerUsd),
  )
}

/**
 * Chat 估值，输入按前缀缓存分档。
 *
 * `cachedInputTokens` 默认 0：不假设命中缓存，估值只会偏高不会偏低。调用方知道自己的
 * system prompt 前缀长度时传进来（PROBE-005 实测该前缀是 64 token）。
 */
export function estimateChatCny(
  pricing: ModelPricing,
  input: { inputTokens: number; cachedInputTokens?: number; outputTokens: number },
): number {
  const inputTokens = requireCount('inputTokens', input.inputTokens)
  const outputTokens = requireCount('outputTokens', input.outputTokens)
  // 命中数超过输入总数是合法的（调用方按 prompt 前缀长度给），按输入总数截断即可；
  // 但它必须先过一遍非负整数校验，否则 `Math.min(-1, 100)` 会把负数原样带下去。
  const cached = Math.min(
    requireCount('cachedInputTokens', input.cachedInputTokens ?? 0),
    inputTokens,
  )
  const uncached = inputTokens - cached
  return roundToLedgerScale(
    tokensToCny(uncached, pricing.chatInputUsdPerMillionTokens, pricing.cnyPerUsd) +
      tokensToCny(cached, pricing.chatCachedInputUsdPerMillionTokens, pricing.cnyPerUsd) +
      tokensToCny(outputTokens, pricing.chatOutputUsdPerMillionTokens, pricing.cnyPerUsd),
  )
}

/**
 * 一次问答四类调用之和，对应 ADR-0029 的「单次 ≤ 5 元」口径：
 * Chat + 查询 Embedding + Reranker + 逐句验证（Embedding + 蕴含）。
 *
 * 逐句验证腿没有独立价目，用 Embedding 与 Chat 两行的单价组合（T12 票据价格表下的第二条
 * 必须显式处理项）。返回分腿明细而不只是总额：超过单次上限时要能说清是哪条腿撑爆的，
 * 也便于写进审计 `detail`。
 */
export function estimateAnswerRunCny(
  pricing: ModelPricing,
  input: {
    queryEmbeddingTokens: number
    rerankCandidateCount: number
    chat: { inputTokens: number; cachedInputTokens?: number; outputTokens: number }
    verification: {
      sentenceCount: number
      embeddingTokensPerSentence: number
      entailmentInputTokensPerSentence: number
      entailmentOutputTokensPerSentence: number
    }
  },
): {
  totalCny: number
  legs: { queryEmbedding: number; rerank: number; chat: number; verification: number }
} {
  const { verification: v } = input
  // 四项各自校验，不能只校验乘积：`sentenceCount: -1` 配 `embeddingTokensPerSentence: -1`
  // 的乘积是 1，负负得正正好绕过下游 `estimateEmbeddingCny` 的校验。
  requireCount('verification.sentenceCount', v.sentenceCount)
  requireCount('verification.embeddingTokensPerSentence', v.embeddingTokensPerSentence)
  requireCount('verification.entailmentInputTokensPerSentence', v.entailmentInputTokensPerSentence)
  requireCount(
    'verification.entailmentOutputTokensPerSentence',
    v.entailmentOutputTokensPerSentence,
  )
  const legs = {
    queryEmbedding: estimateEmbeddingCny(pricing, { tokens: input.queryEmbeddingTokens }),
    rerank: estimateRerankCny(pricing, { candidateCount: input.rerankCandidateCount }),
    chat: estimateChatCny(pricing, input.chat),
    verification: roundToLedgerScale(
      estimateEmbeddingCny(pricing, {
        tokens: v.sentenceCount * v.embeddingTokensPerSentence,
      }) +
        estimateChatCny(pricing, {
          inputTokens: v.sentenceCount * v.entailmentInputTokensPerSentence,
          outputTokens: v.sentenceCount * v.entailmentOutputTokensPerSentence,
        }),
    ),
  }
  return {
    totalCny: roundToLedgerScale(legs.queryEmbedding + legs.rerank + legs.chat + legs.verification),
    legs,
  }
}
