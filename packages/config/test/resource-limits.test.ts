import { describe, expect, it } from 'vitest'
import {
  parseResourceLimits,
  resourceLimitsDefaults,
  resourceLimitsSchema,
} from '../src/resource-limits'

describe('资源边界 schema', () => {
  it('冻结默认值本身必须通过校验', () => {
    expect(() => parseResourceLimits(resourceLimitsDefaults)).not.toThrow()
  })

  it('ingestion 并发不得超过 4', () => {
    const bad = {
      ...resourceLimitsDefaults,
      ingestion: { ...resourceLimitsDefaults.ingestion, concurrency: 5 },
    }
    expect(() => parseResourceLimits(bad)).toThrow()
  })

  it('evaluation Profile 并发与 in-flight 固定为 1', () => {
    for (const key of ['concurrency', 'inFlight'] as const) {
      const bad = {
        ...resourceLimitsDefaults,
        evaluation: { ...resourceLimitsDefaults.evaluation, [key]: 2 },
      }
      expect(() => parseResourceLimits(bad)).toThrow()
    }
  })

  it('parse prefetch 固定为 1，projection prefetch 不得超过 4', () => {
    const badParse = {
      ...resourceLimitsDefaults,
      ingestion: { ...resourceLimitsDefaults.ingestion, parsePrefetch: 2 },
    }
    const badProjection = {
      ...resourceLimitsDefaults,
      ingestion: { ...resourceLimitsDefaults.ingestion, projectionPrefetch: 8 },
    }
    expect(() => parseResourceLimits(badParse)).toThrow()
    expect(() => parseResourceLimits(badProjection)).toThrow()
  })

  it('预算上限不得超过 5 / 16 / 500 元', () => {
    const cases = [
      { singleCallCny: 6, dailyCny: 16, monthlyCny: 500 },
      { singleCallCny: 5, dailyCny: 17, monthlyCny: 500 },
      { singleCallCny: 5, dailyCny: 16, monthlyCny: 501 },
    ]
    for (const budget of cases) {
      expect(() => parseResourceLimits({ ...resourceLimitsDefaults, budget })).toThrow()
    }
  })

  it('预算上限必须单调：单次 <= 每日 <= 每月', () => {
    const bad = {
      ...resourceLimitsDefaults,
      budget: { singleCallCny: 5, dailyCny: 4, monthlyCny: 500 },
    }
    expect(() => parseResourceLimits(bad)).toThrow(/单调|单次/)
  })

  it('检索预算：fan-out <= 2、候选 <= 1024、请求超时 <= 250 ms、复核 P95 <= 60 ms', () => {
    const cases = [
      { maxKnowledgeSpaceFanOut: 3 },
      { candidateBudget: 2048 },
      { requestTimeoutMs: 500 },
      { aclRecheckP95BudgetMs: 120 },
    ]
    for (const patch of cases) {
      const bad = {
        ...resourceLimitsDefaults,
        retrieval: { ...resourceLimitsDefaults.retrieval, ...patch },
      }
      expect(() => parseResourceLimits(bad)).toThrow()
    }
  })

  it('字符串形式的环境变量值可被强制转换', () => {
    const parsed = resourceLimitsSchema.parse({
      ...resourceLimitsDefaults,
      ingestion: { concurrency: '4', inFlight: '8', parsePrefetch: '1', projectionPrefetch: '4' },
    })
    expect(parsed.ingestion.concurrency).toBe(4)
  })

  it('未知 Worker Profile 被拒绝', () => {
    expect(() => parseResourceLimits({ ...resourceLimitsDefaults, workerProfile: 'api' })).toThrow()
  })
})
