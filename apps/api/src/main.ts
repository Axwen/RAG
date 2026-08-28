import 'reflect-metadata'
import { NestFactory } from '@nestjs/core'
import { parsePort } from '@rag/config'
import { createLogger } from '@rag/observability'
import { AppModule } from './app.module'

const logger = createLogger({ bindings: { service: 'api' } })

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true })
  app.enableShutdownHooks()
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
