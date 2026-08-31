import 'reflect-metadata'
import { NestFactory } from '@nestjs/core'
import { parsePort, preloadRootEnv } from '@rag/config'
import { createLogger } from '@rag/observability'
import { AppModule } from './app.module'
import { GlobalExceptionFilter } from './common/global-exception.filter'

// DX-T1：先预载仓库根 .env（不覆盖已存在变量），再解析任何依赖配置。
preloadRootEnv()

const logger = createLogger({ bindings: { service: 'api' } })

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true })
  app.enableShutdownHooks()
  // DX-T3：所有错误响应统一为五字段信封
  app.useGlobalFilters(new GlobalExceptionFilter())
  const port = parsePort(process.env.API_PORT ?? 3001, 'API_PORT')
  await app.listen(port)
  logger.info({ port }, 'api listening')
}

void bootstrap().catch((error: unknown) => {
  logger.error(
    { err: error instanceof Error ? error.message : String(error) },
    'api bootstrap failed',
  )
  process.exitCode = 1
})
