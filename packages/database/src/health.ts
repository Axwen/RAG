import { Client } from 'pg'
import type { DependencyHealth } from '@rag/observability'
import { requireDatabaseUrl } from './env'

/**
 * PostgreSQL 健康探测。
 *
 * PostgreSQL 是业务事实的唯一权威（ADR-0001），因此这里做真实往返 `SELECT 1`，
 * 而不是只探端口：端口可达但数据库拒绝连接时必须报 down。
 */
export async function probePostgres(
  name = 'postgres',
  options: { readonly connectionString?: string; readonly timeoutMs?: number } = {},
): Promise<DependencyHealth> {
  const timeoutMs = options.timeoutMs ?? 2000
  const connectionString = options.connectionString ?? requireDatabaseUrl()
  const startedAt = Date.now()
  const client = new Client({
    connectionString,
    connectionTimeoutMillis: timeoutMs,
    statement_timeout: timeoutMs,
    application_name: 'rag-health',
  })
  try {
    await client.connect()
    await client.query('SELECT 1')
    return { name, status: 'up', latencyMs: Date.now() - startedAt }
  } catch (error) {
    const code =
      error instanceof Error
        ? ((error as NodeJS.ErrnoException).code ?? error.message.slice(0, 120))
        : 'unknown_error'
    return { name, status: 'down', latencyMs: Date.now() - startedAt, reason: code }
  } finally {
    await client.end().catch(() => undefined)
  }
}
