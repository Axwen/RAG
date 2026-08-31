import { preloadRootEnv } from '@rag/config'
import { createLogger } from '@rag/observability'
import { createHealthServer } from './health-server'
import { loadWorkerRuntimeConfig } from './profile'

/**
 * Worker 启动入口。
 *
 * T0 只完成 Profile 解析、边界暴露与健康入口。队列消费、Outbox 投递、
 * 解析编排与评测批处理按票据加入（T3、T4、T10、T13）。
 */
function main(): void {
  // DX-T1：先预载仓库根 .env（不覆盖已存在变量），再解析 Profile。
  preloadRootEnv()
  const config = loadWorkerRuntimeConfig()
  const logger = createLogger({ bindings: { service: 'worker', profile: config.profile } })
  const server = createHealthServer(config)
  server.listen(config.healthPort, () => {
    logger.info(
      {
        profile: config.profile,
        concurrency: config.concurrency,
        inFlight: config.inFlight,
        healthPort: config.healthPort,
      },
      'worker started',
    )
  })
  const shutdown = (signal: string): void => {
    logger.info({ signal }, 'worker shutting down')
    server.close(() => process.exit(0))
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}

try {
  main()
} catch (error) {
  const logger = createLogger({ bindings: { service: 'worker' } })
  logger.error(
    { err: error instanceof Error ? error.message : String(error) },
    'worker start failed',
  )
  process.exitCode = 1
}
