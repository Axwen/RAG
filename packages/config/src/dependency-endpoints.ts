import { z } from 'zod'

/**
 * 本地与 CI 环境中六个中间件的接入点解析。
 *
 * 这里只做环境变量解析，不做任何 I/O：健康探测原语在 `@rag/observability`，
 * PostgreSQL 往返在 `@rag/database`。变量名与 `.env.example` 一一对应。
 */
export const portSchema = z.coerce.number().int().positive().max(65535)
const url = z.url()

export const dependencyEndpointsSchema = z.object({
  postgresUrl: z.string().min(1),
  opensearchNode: url,
  opensearchRequestTimeoutMs: z.coerce.number().int().positive().max(250),
  rabbitmqHost: z.string().min(1),
  rabbitmqPort: portSchema,
  rabbitmqManagementPort: portSchema,
  redisHost: z.string().min(1),
  redisPort: portSchema,
  minioEndpoint: url,
  keycloakBaseUrl: url,
  keycloakRealm: z.string().min(1),
})

export type DependencyEndpoints = z.infer<typeof dependencyEndpointsSchema>

/** 解析监听或依赖端口；非法值在启动阶段明确失败。 */
export function parsePort(value: unknown, variableName: string): number {
  const parsed = portSchema.safeParse(value)
  if (!parsed.success) {
    throw new Error(`环境变量 ${variableName} 必须是 1 到 65535 的整数`)
  }
  return parsed.data
}

/** 解析 `redis://host:port` 形式的连接串；解析失败即抛出，不静默回退。 */
export function parseRedisUrl(value: string): { host: string; port: number } {
  const parsed = new URL(value)
  if (parsed.protocol !== 'redis:' && parsed.protocol !== 'rediss:') {
    throw new Error(`REDIS_URL 协议不受支持：${parsed.protocol}`)
  }
  return {
    host: parsed.hostname,
    port: parsePort(parsed.port === '' ? 6379 : parsed.port, 'REDIS_URL 端口'),
  }
}

/**
 * 从环境变量解析依赖接入点。
 *
 * 缺失或非法即抛出。启动阶段就要暴露配置错误，不允许运行到第一次请求才失败。
 */
export function loadDependencyEndpoints(env: NodeJS.ProcessEnv = process.env): DependencyEndpoints {
  const redis = parseRedisUrl(env.REDIS_URL ?? 'redis://localhost:6379')
  return dependencyEndpointsSchema.parse({
    postgresUrl: env.DATABASE_URL,
    opensearchNode: env.OPENSEARCH_NODE ?? 'http://localhost:9200',
    opensearchRequestTimeoutMs: env.OPENSEARCH_REQUEST_TIMEOUT_MS ?? 250,
    rabbitmqHost: env.RABBITMQ_HOST ?? 'localhost',
    rabbitmqPort: env.RABBITMQ_PORT ?? 5672,
    rabbitmqManagementPort: env.RABBITMQ_MANAGEMENT_PORT ?? 15672,
    redisHost: redis.host,
    redisPort: redis.port,
    minioEndpoint: env.MINIO_ENDPOINT ?? 'http://localhost:9000',
    keycloakBaseUrl: env.KEYCLOAK_BASE_URL ?? 'http://localhost:8080',
    keycloakRealm: env.KEYCLOAK_REALM ?? 'rag-local',
  })
}

/** Keycloak Realm 的 OIDC discovery 地址；健康检查与 T14 共用同一构造。 */
export function oidcDiscoveryUrl(baseUrl: string, realm: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/realms/${realm}/.well-known/openid-configuration`
}
