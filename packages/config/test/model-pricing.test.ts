import { describe, expect, it } from 'vitest'
import {
  estimateAnswerRunCny,
  estimateChatCny,
  estimateEmbeddingCny,
  estimateRerankCny,
  modelPricingDefaults,
  parseModelPricing,
} from '../src/model-pricing'
import { resourceLimitsDefaults } from '../src/resource-limits'

/** PROBE-005 Stage C 的 LIVE 成本锚点（汇率 7.2），见 T12 票据的预扣估值价格表。 */
const rerankAnchors = [
  { candidateCount: 8, cny: 0.0012 },
  { candidateCount: 64, cny: 0.0099 },
  { candidateCount: 256, cny: 0.0397 },
  { candidateCount: 1024, cny: 0.1587 },
] as const

describe('模型价目 schema', () => {
  it('冻结默认值本身必须通过校验', () => {
    expect(() => parseModelPricing(modelPricingDefaults)).not.toThrow()
  })

  /**
   * 单价 0 的后果不是估值偏低，是那条腿的预扣恒为 0——四层 CAS 全部通过，门禁静默打开。
   * 而 `z.coerce.number()` 把空串、`null`、空白串、`[]`、`false` 全部折成 0，T12b 的运行配置
   * 正是从环境变量读这几个值，所以「配置项缺失」与「免费」在 `.nonnegative()` 下无法区分。
   */
  it.each([0, '', ' ', null, [], false, -1, '-0.5', Number.NaN, Number.POSITIVE_INFINITY])(
    '单价 %p 被拒绝：0 与「折成 0」的空值都会让这条腿的预扣恒为 0',
    (embeddingUsdPerMillionTokens) => {
      expect(() =>
        parseModelPricing({ ...modelPricingDefaults, embeddingUsdPerMillionTokens }),
      ).toThrow()
    },
  )

  it('真的有免费档写显式极小值，仍然通过：禁的是 0，不是「便宜」', () => {
    const pricing = parseModelPricing({
      ...modelPricingDefaults,
      chatCachedInputUsdPerMillionTokens: '0.000001',
    })
    expect(pricing.chatCachedInputUsdPerMillionTokens).toBe(0.000001)
  })

  it('五个单价字段用的是同一条约束，不是只修了 embedding 那一行', () => {
    const priceFields = [
      'embeddingUsdPerMillionTokens',
      'rerankerUsdPerMillionTokens',
      'chatInputUsdPerMillionTokens',
      'chatCachedInputUsdPerMillionTokens',
      'chatOutputUsdPerMillionTokens',
    ] as const
    for (const field of priceFields) {
      expect(() => parseModelPricing({ ...modelPricingDefaults, [field]: 0 })).toThrow()
    }
  })

  it('汇率打错一位（7.2 → 72）被拒绝', () => {
    expect(() => parseModelPricing({ ...modelPricingDefaults, cnyPerUsd: 72 })).toThrow()
  })

  it('缓存命中价高于未缓存价被拒绝', () => {
    expect(() =>
      parseModelPricing({ ...modelPricingDefaults, chatCachedInputUsdPerMillionTokens: 0.2 }),
    ).toThrow(/缓存命中价/)
  })

  it('默认缓存命中价等于未缓存价：折扣率没有实测支撑，不编一个让预扣偏低', () => {
    expect(modelPricingDefaults.chatCachedInputUsdPerMillionTokens).toBe(
      modelPricingDefaults.chatInputUsdPerMillionTokens,
    )
  })
})

describe('rerank 预扣估值', () => {
  it.each(rerankAnchors)(
    '候选 $candidateCount 在 ±5% 内复现 LIVE 锚点 ¥$cny',
    ({ candidateCount, cny }) => {
      const estimated = estimateRerankCny(modelPricingDefaults, { candidateCount })
      expect(Math.abs(estimated - cny) / cny).toBeLessThanOrEqual(0.05)
    },
  )

  it('随候选数线性变化，不是固定值', () => {
    const small = estimateRerankCny(modelPricingDefaults, { candidateCount: 64 })
    const large = estimateRerankCny(modelPricingDefaults, { candidateCount: 1024 })
    expect(large).toBeGreaterThan(small)
    expect(large / small).toBeCloseTo(16, 1)
  })
})

describe('Chat 预扣估值', () => {
  it('复现 PROBE-005 单次问答 ¥0.00064（prompt 165 / completion 246）', () => {
    const estimated = estimateChatCny(modelPricingDefaults, {
      inputTokens: 165,
      cachedInputTokens: 64,
      outputTokens: 246,
    })
    expect(Math.abs(estimated - 0.00064) / 0.00064).toBeLessThanOrEqual(0.05)
  })

  it('缓存命中价低于未缓存价时，命中越多估值越低', () => {
    const pricing = { ...modelPricingDefaults, chatCachedInputUsdPerMillionTokens: 0.01 }
    const withCache = estimateChatCny(pricing, {
      inputTokens: 1000,
      cachedInputTokens: 500,
      outputTokens: 0,
    })
    const withoutCache = estimateChatCny(pricing, { inputTokens: 1000, outputTokens: 0 })
    expect(withCache).toBeLessThan(withoutCache)
  })

  it('命中数超过输入总数时按输入总数截断，不出现负的未缓存 token', () => {
    const estimated = estimateChatCny(modelPricingDefaults, {
      inputTokens: 100,
      cachedInputTokens: 999,
      outputTokens: 0,
    })
    expect(estimated).toBeGreaterThan(0)
  })
})

describe('一次问答四类调用之和', () => {
  /** ADR-0029：单次 ≤ 5 元覆盖 Chat + 查询 Embedding + Reranker + 逐句验证之和。 */
  const worstCase = {
    queryEmbeddingTokens: 64,
    rerankCandidateCount: 1024,
    chat: { inputTokens: 8000, cachedInputTokens: 64, outputTokens: 1200 },
    verification: {
      sentenceCount: 40,
      embeddingTokensPerSentence: 64,
      entailmentInputTokensPerSentence: 600,
      entailmentOutputTokensPerSentence: 40,
    },
  }

  it('四条腿都计入总额，逐句验证腿不为零', () => {
    const { totalCny, legs } = estimateAnswerRunCny(modelPricingDefaults, worstCase)
    expect(legs.verification).toBeGreaterThan(0)
    for (const leg of Object.values(legs)) expect(leg).toBeGreaterThan(0)
    expect(totalCny).toBeCloseTo(
      Number((legs.queryEmbedding + legs.rerank + legs.chat + legs.verification).toFixed(6)),
      6,
    )
  })

  it('满额 1024 候选的一次问答仍在单次 5 元上限内', () => {
    const { totalCny } = estimateAnswerRunCny(modelPricingDefaults, worstCase)
    expect(totalCny).toBeLessThan(resourceLimitsDefaults.budget.singleCallCny)
  })

  it('rerank 是最大的单项（ADR-0029 补充的实测结论）', () => {
    const { legs } = estimateAnswerRunCny(modelPricingDefaults, worstCase)
    expect(legs.rerank).toBeGreaterThan(legs.chat)
    expect(legs.rerank).toBeGreaterThan(legs.verification)
    expect(legs.rerank).toBeGreaterThan(legs.queryEmbedding)
  })
})

/**
 * 入参校验（T12「预扣不能低于真实支出」在函数边界上的落点）。
 *
 * 单条负腿在 `reserveBudget` 会被「预扣金额为负」挡下，所以这里真正防的是**相加时的抵消**：
 * `estimateAnswerRunCny` 把四条腿求和，一条负腿只会让总额偏低而不为负，四层 CAS 全部通过。
 * `NaN` 更彻底——它让账本侧每一次 `greaterThan` 都为 false，等于每层上限都「没超」。
 */
describe('估值入参校验', () => {
  const badCounts = [-1, -1000, 0.5, Number.NaN, Number.POSITIVE_INFINITY] as const

  it.each(badCounts)('Embedding tokens = %p 抛错', (tokens) => {
    expect(() => estimateEmbeddingCny(modelPricingDefaults, { tokens })).toThrow(/非负整数/)
  })

  it.each(badCounts)('rerank candidateCount = %p 抛错', (candidateCount) => {
    expect(() => estimateRerankCny(modelPricingDefaults, { candidateCount })).toThrow(/非负整数/)
  })

  it.each(badCounts)('Chat inputTokens = %p 抛错', (inputTokens) => {
    expect(() => estimateChatCny(modelPricingDefaults, { inputTokens, outputTokens: 10 })).toThrow(
      /非负整数/,
    )
  })

  it.each(badCounts)('Chat outputTokens = %p 抛错', (outputTokens) => {
    expect(() => estimateChatCny(modelPricingDefaults, { inputTokens: 10, outputTokens })).toThrow(
      /非负整数/,
    )
  })

  it('Chat cachedInputTokens 为负抛错，超过输入总数仍然合法（按输入截断）', () => {
    expect(() =>
      estimateChatCny(modelPricingDefaults, {
        inputTokens: 100,
        cachedInputTokens: -1,
        outputTokens: 0,
      }),
    ).toThrow(/非负整数/)
    expect(
      estimateChatCny(modelPricingDefaults, {
        inputTokens: 100,
        cachedInputTokens: 999,
        outputTokens: 0,
      }),
    ).toBeGreaterThan(0)
  })

  it('0 是合法入参：0 token / 0 候选 / 0 句的估值是 0，不是错误', () => {
    expect(estimateEmbeddingCny(modelPricingDefaults, { tokens: 0 })).toBe(0)
    expect(estimateRerankCny(modelPricingDefaults, { candidateCount: 0 })).toBe(0)
    expect(estimateChatCny(modelPricingDefaults, { inputTokens: 0, outputTokens: 0 })).toBe(0)
  })

  it('负候选数不再返回负估值（回归：曾返回 -0.000156）', () => {
    expect(() => estimateRerankCny(modelPricingDefaults, { candidateCount: -1 })).toThrow()
  })

  /** 负负得正是这条校验必须逐项做、不能只校验乘积的原因。 */
  it('逐句验证的四项逐项校验：sentenceCount 与 tokensPerSentence 同为 -1 的乘积是 1，也要抛', () => {
    const input = {
      queryEmbeddingTokens: 64,
      rerankCandidateCount: 64,
      chat: { inputTokens: 100, outputTokens: 100 },
      verification: {
        sentenceCount: -1,
        embeddingTokensPerSentence: -1,
        entailmentInputTokensPerSentence: 600,
        entailmentOutputTokensPerSentence: 40,
      },
    }
    expect(() => estimateAnswerRunCny(modelPricingDefaults, input)).toThrow(
      /verification\.sentenceCount/,
    )
  })

  it.each([
    'embeddingTokensPerSentence',
    'entailmentInputTokensPerSentence',
    'entailmentOutputTokensPerSentence',
  ] as const)('逐句验证的 %s 为负也抛', (field) => {
    const input = {
      queryEmbeddingTokens: 64,
      rerankCandidateCount: 64,
      chat: { inputTokens: 100, outputTokens: 100 },
      verification: {
        sentenceCount: 40,
        embeddingTokensPerSentence: 64,
        entailmentInputTokensPerSentence: 600,
        entailmentOutputTokensPerSentence: 40,
        [field]: -1,
      },
    }
    expect(() => estimateAnswerRunCny(modelPricingDefaults, input)).toThrow(/非负整数/)
  })
})

/**
 * `ModelPricing` 只约束形状：`{ ...modelPricingDefaults, embeddingUsdPerMillionTokens: 0 }`
 * 是合法的 `ModelPricing`，TypeScript 不会拦。所以 schema 的正数约束必须在估值函数里再兜一次，
 * 口径同迁移里那条 `reasonCode` 格式 CHECK——兜住绕过 schema 的路径。
 */
describe('绕过 schema 的价目也要挡住', () => {
  it('手搓单价 0 的价目，估值抛错而不是返回 0', () => {
    const zeroPrice = { ...modelPricingDefaults, embeddingUsdPerMillionTokens: 0 }
    expect(() => estimateEmbeddingCny(zeroPrice, { tokens: 1000 })).toThrow(/单价必须为正/)
  })

  it('手搓汇率 0 的价目，估值抛错', () => {
    const zeroRate = { ...modelPricingDefaults, cnyPerUsd: 0 }
    expect(() => estimateEmbeddingCny(zeroRate, { tokens: 1000 })).toThrow(/汇率必须为正/)
  })

  it('手搓 rerankTokensPerCandidate = 0，rerank 估值抛错而不是恒为 0', () => {
    const zeroTokens = { ...modelPricingDefaults, rerankTokensPerCandidate: 0 }
    expect(() => estimateRerankCny(zeroTokens, { candidateCount: 1024 })).toThrow(
      /rerankTokensPerCandidate/,
    )
  })

  it('手搓 NaN 单价也抛：NaN 会让账本侧每一次比较都为 false', () => {
    const nanPrice = { ...modelPricingDefaults, chatOutputUsdPerMillionTokens: Number.NaN }
    expect(() => estimateChatCny(nanPrice, { inputTokens: 10, outputTokens: 10 })).toThrow(
      /单价必须为正/,
    )
  })
})
