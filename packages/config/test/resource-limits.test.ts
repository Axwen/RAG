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
    const cases = [{ singleCallCny: 6 }, { dailyCny: 17 }, { monthlyCny: 501 }]
    for (const patch of cases) {
      const bad = {
        ...resourceLimitsDefaults,
        budget: { ...resourceLimitsDefaults.budget, ...patch },
      }
      expect(() => parseResourceLimits(bad)).toThrow()
    }
  })

  it('预算上限必须单调：单次 <= 每日 <= 每月', () => {
    const bad = {
      ...resourceLimitsDefaults,
      budget: { ...resourceLimitsDefaults.budget, dailyCny: 4 },
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

describe('预算池三分（ADR-0029）', () => {
  const withBudget = (patch: Record<string, unknown>) => ({
    ...resourceLimitsDefaults,
    budget: { ...resourceLimitsDefaults.budget, ...patch },
  })

  it('默认值就是 ADR-0029 的 350 / 100 / 50', () => {
    expect(resourceLimitsDefaults.budget.pools).toEqual({
      interactive: 350,
      evaluation: 100,
      reserve: 50,
    })
  })

  it('三个池之和必须等于月度上限，多一元与少一元都失败', () => {
    for (const reserve of [51, 49]) {
      expect(() =>
        parseResourceLimits(
          withBudget({ pools: { ...resourceLimitsDefaults.budget.pools, reserve } }),
        ),
      ).toThrow(/池之和/)
    }
  })

  it('单个池不得超过各自上限，即使总和仍然等于月度上限', () => {
    const bad = withBudget({ pools: { interactive: 400, evaluation: 50, reserve: 50 } })
    expect(() => parseResourceLimits(bad)).toThrow()
  })

  it('每日上限 × 31 天不得超过月度上限', () => {
    const bad = withBudget({
      monthlyCny: 400,
      dailyCny: 16,
      pools: { interactive: 250, evaluation: 100, reserve: 50 },
    })
    expect(() => parseResourceLimits(bad)).toThrow(/31/)
  })

  it('池额度为字符串时先强制转换再比较总和，不做字符串拼接', () => {
    const parsed = parseResourceLimits(
      withBudget({ pools: { interactive: '350', evaluation: '100', reserve: '50' } }),
    )
    expect(parsed.budget.pools.interactive).toBe(350)
  })
})

describe('预算 lease 时长（ADR-0029）', () => {
  const withLease = (patch: Record<string, unknown>) => ({
    ...resourceLimitsDefaults,
    budget: {
      ...resourceLimitsDefaults.budget,
      lease: { ...resourceLimitsDefaults.budget.lease, ...patch },
    },
  })

  it('默认 lease 为 60 秒', () => {
    expect(resourceLimitsDefaults.budget.lease.defaultSeconds).toBe(60)
  })

  it('默认时长与单次续租时长都不得超过总时长上限', () => {
    for (const patch of [
      { defaultSeconds: 200, maxTotalSeconds: 120 },
      { maxRenewSeconds: 200, maxTotalSeconds: 120 },
    ]) {
      expect(() => parseResourceLimits(withLease(patch))).toThrow(/总时长/)
    }
  })

  it('单次 lease 不得超过 300 秒：靠调大默认值掩盖没人续租的路径在配置层就走不通', () => {
    expect(() => parseResourceLimits(withLease({ defaultSeconds: 600 }))).toThrow()
  })
})

describe('用户级配额与管理侧配额（ADR-0034）', () => {
  it('五个限额值以默认值形式落地', () => {
    expect(resourceLimitsDefaults.userQuota).toEqual({
      concurrentAnswerRuns: 1,
      concurrentSseConnections: 2,
      questionsPerMinute: 10,
      questionsPerDay: 200,
      uploadsPerHour: 20,
    })
    expect(resourceLimitsDefaults.adminQuota.concurrentRebuildsPerTenant).toBe(1)
  })

  /** ADR-0034 明确这五个是初始值，校准写运行配置、不重开 ADR——所以它们不是代码级硬上限。 */
  it('允许按运行配置上调，不像 5/16/500 那样是代码级上界', () => {
    const tuned = parseResourceLimits({
      ...resourceLimitsDefaults,
      userQuota: {
        ...resourceLimitsDefaults.userQuota,
        concurrentAnswerRuns: 4,
        questionsPerMinute: 30,
        questionsPerDay: 1000,
      },
      adminQuota: { concurrentRebuildsPerTenant: 2 },
    })
    expect(tuned.userQuota.questionsPerMinute).toBe(30)
    expect(tuned.adminQuota.concurrentRebuildsPerTenant).toBe(2)
  })

  it('数量级打错仍被拒绝：护栏只防手滑，不替 ADR 定值', () => {
    const cases = [
      { concurrentAnswerRuns: 99 },
      { concurrentSseConnections: 100 },
      { questionsPerMinute: 1000 },
      { questionsPerDay: 99_999 },
      { uploadsPerHour: 5000 },
    ]
    for (const patch of cases) {
      const bad = {
        ...resourceLimitsDefaults,
        userQuota: { ...resourceLimitsDefaults.userQuota, ...patch },
      }
      expect(() => parseResourceLimits(bad)).toThrow()
    }
  })

  it('每日提问上限不得小于每分钟上限', () => {
    const bad = {
      ...resourceLimitsDefaults,
      userQuota: {
        ...resourceLimitsDefaults.userQuota,
        questionsPerMinute: 10,
        questionsPerDay: 5,
      },
    }
    expect(() => parseResourceLimits(bad)).toThrow(/每日提问/)
  })

  it('并发与频次都必须是正整数', () => {
    for (const patch of [{ concurrentAnswerRuns: 0 }, { questionsPerMinute: 1.5 }]) {
      const bad = {
        ...resourceLimitsDefaults,
        userQuota: { ...resourceLimitsDefaults.userQuota, ...patch },
      }
      expect(() => parseResourceLimits(bad)).toThrow()
    }
  })
})
