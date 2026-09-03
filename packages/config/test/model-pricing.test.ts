import { describe, expect, it } from 'vitest'
import {
  estimateAnswerRunCny,
  estimateChatCny,
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
