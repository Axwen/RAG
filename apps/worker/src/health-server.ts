import { createServer, type Server } from 'node:http'
import { probePostgres } from '@rag/database'
import { aggregateHealth, probeTcp, type HealthReport } from '@rag/observability'
import type { WorkerRuntimeConfig } from './profile'

/**
 * Worker 最小健康入口。
 *
 * Worker 没有对外 HTTP 面，这里只提供 `/health/live` 与 `/health/ready`，用于
 * Compose 健康检查和本地排查。Worker 的依赖是 PostgreSQL（状态权威）与
 * RabbitMQ（传输），因此只探这两项；任一不可用即 503。
 */
export async function checkWorkerHealth(config: WorkerRuntimeConfig): Promise<HealthReport> {
  const dependencies = await Promise.all([
    probePostgres('postgres', { connectionString: config.endpoints.postgresUrl }),
    probeTcp('rabbitmq', config.endpoints.rabbitmqHost, config.endpoints.rabbitmqPort),
  ])
  return aggregateHealth(dependencies)
}

export function createHealthServer(config: WorkerRuntimeConfig): Server {
  return createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0]
    if (path === '/health/live') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ status: 'ok', service: 'worker', profile: config.profile }))
      return
    }
    if (path === '/health/ready') {
      void checkWorkerHealth(config)
        .then((report) => {
          res.writeHead(report.status === 'up' ? 200 : 503, {
            'content-type': 'application/json',
          })
          res.end(JSON.stringify({ ...report, profile: config.profile }))
        })
        .catch(() => {
          res.writeHead(503, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ status: 'down', reason: 'health_check_failed' }))
        })
      return
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ status: 'not_found' }))
  })
}
