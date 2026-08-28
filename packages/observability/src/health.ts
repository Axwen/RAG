import { connect } from 'node:net'

/**
 * 依赖健康探测原语。
 *
 * T0 验收要求：中间件关闭时错误必须明确，不得伪装为可用。因此所有探测在失败时
 * 返回 `down` 并携带简短原因，调用方据此返回 503，不允许降级为 200。
 * 探测只做连通性与协议级最小往返，不做业务查询。
 */
export type HealthStatus = 'up' | 'down'

export interface DependencyHealth {
  readonly name: string
  readonly status: HealthStatus
  readonly latencyMs: number
  /** 仅在 `down` 时出现；固定为短原因，不回显响应体，避免内容进入日志。 */
  readonly reason?: string
}

export interface HealthReport {
  readonly status: HealthStatus
  readonly checkedAt: string
  readonly dependencies: readonly DependencyHealth[]
}

/** 单次探测默认超时。健康检查不允许长时间挂起。 */
export const DEFAULT_PROBE_TIMEOUT_MS = 2000

function shortReason(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code
    return code ?? error.message.slice(0, 120)
  }
  return 'unknown_error'
}

async function timed(name: string, run: () => Promise<void>): Promise<DependencyHealth> {
  const startedAt = Date.now()
  try {
    await run()
    return { name, status: 'up', latencyMs: Date.now() - startedAt }
  } catch (error) {
    return {
      name,
      status: 'down',
      latencyMs: Date.now() - startedAt,
      reason: shortReason(error),
    }
  }
}

export interface HttpProbeOptions {
  readonly timeoutMs?: number
  readonly headers?: Readonly<Record<string, string>>
  /** 视为健康的状态码；默认 2xx。 */
  readonly acceptStatus?: (status: number) => boolean
}

/** HTTP 探测。只看状态码，不读响应体。 */
export function probeHttp(
  name: string,
  url: string,
  options: HttpProbeOptions = {},
): Promise<DependencyHealth> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS
  const accept = options.acceptStatus ?? ((status: number) => status >= 200 && status < 300)
  return timed(name, async () => {
    const response = await fetch(url, {
      method: 'GET',
      signal: AbortSignal.timeout(timeoutMs),
      ...(options.headers ? { headers: { ...options.headers } } : {}),
    })
    if (!accept(response.status)) {
      throw new Error(`unexpected_status_${response.status}`)
    }
  })
}

/** TCP 连通性探测。用于没有廉价 HTTP 健康入口的依赖。 */
export function probeTcp(
  name: string,
  host: string,
  port: number,
  timeoutMs: number = DEFAULT_PROBE_TIMEOUT_MS,
): Promise<DependencyHealth> {
  return timed(name, async () => {
    await tcpRoundTrip(host, port, timeoutMs)
  })
}

/** Redis 探测：inline PING，期望 `+PONG`。不引入 Redis 客户端依赖。 */
export function probeRedis(
  name: string,
  host: string,
  port: number,
  timeoutMs: number = DEFAULT_PROBE_TIMEOUT_MS,
): Promise<DependencyHealth> {
  return timed(name, async () => {
    const reply = await tcpRoundTrip(host, port, timeoutMs, 'PING\r\n')
    if (!reply.startsWith('+PONG')) {
      throw new Error('unexpected_redis_reply')
    }
  })
}

function tcpRoundTrip(
  host: string,
  port: number,
  timeoutMs: number,
  payload?: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port })
    let settled = false
    const finish = (error: Error | null, reply = ''): void => {
      if (settled) return
      settled = true
      socket.destroy()
      if (error) reject(error)
      else resolve(reply)
    }
    socket.setTimeout(timeoutMs, () => finish(new Error('ETIMEDOUT')))
    socket.on('error', (error) => finish(error))
    socket.on('connect', () => {
      if (payload === undefined) finish(null)
      else socket.write(payload)
    })
    socket.on('data', (chunk: Buffer) => finish(null, chunk.toString('utf8')))
  })
}

/** 聚合：任一依赖 down 则整体 down。健康检查不做加权，不做部分可用。 */
export function aggregateHealth(dependencies: readonly DependencyHealth[]): HealthReport {
  return {
    status: dependencies.every((d) => d.status === 'up') ? 'up' : 'down',
    checkedAt: new Date().toISOString(),
    dependencies,
  }
}
