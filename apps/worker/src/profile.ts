import {
  loadDependencyEndpoints,
  parsePort,
  resourceLimitsDefaults,
  workerProfileNames,
  type DependencyEndpoints,
  type WorkerProfileName,
} from '@rag/config'

/**
 * Worker Profile 解析。
 *
 * 同一份代码以两个启动 Profile 运行（ADR-0025）：`ingestion` 与 `evaluation`
 * 使用独立队列、独立并发与独立预算池，不允许一个进程同时承担两者。
 * T0 只解析并暴露边界值，运行时强制（并发、in-flight、prefetch、RSS 警戒）在 T10。
 */
export interface WorkerRuntimeConfig {
  readonly profile: WorkerProfileName
  readonly concurrency: number
  readonly inFlight: number
  readonly endpoints: DependencyEndpoints
  readonly healthPort: number
}

export function resolveProfile(value: string | undefined): WorkerProfileName {
  if (value === undefined || value.trim() === '') {
    throw new Error(
      `缺少环境变量 WORKER_PROFILE：必须显式指定 ${workerProfileNames.join(' 或 ')}，不提供默认值`,
    )
  }
  const normalized = value.trim()
  const match = workerProfileNames.find((name) => name === normalized)
  if (match === undefined) {
    throw new Error(
      `未知 WORKER_PROFILE "${normalized}"：只允许 ${workerProfileNames.join(' 或 ')}`,
    )
  }
  return match
}

export function loadWorkerRuntimeConfig(env: NodeJS.ProcessEnv = process.env): WorkerRuntimeConfig {
  const profile = resolveProfile(env.WORKER_PROFILE)
  const limits =
    profile === 'ingestion' ? resourceLimitsDefaults.ingestion : resourceLimitsDefaults.evaluation
  return {
    profile,
    concurrency: limits.concurrency,
    inFlight: limits.inFlight,
    endpoints: loadDependencyEndpoints(env),
    healthPort: parsePort(env.WORKER_HEALTH_PORT ?? 3002, 'WORKER_HEALTH_PORT'),
  }
}
