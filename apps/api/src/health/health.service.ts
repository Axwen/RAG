import { Injectable } from '@nestjs/common'
import { loadDependencyEndpoints, oidcDiscoveryUrl, type DependencyEndpoints } from '@rag/config'
import { probePostgres } from '@rag/database'
import {
  aggregateHealth,
  probeHttp,
  probeRedis,
  probeTcp,
  type HealthReport,
} from '@rag/observability'

/**
 * 依赖健康检查。
 *
 * 只做连通性与协议级最小往返，不做业务查询。任一依赖不可用时整体 down，
 * 由控制层返回 503：T0 验收要求关闭中间件时错误明确，不得伪装为可用。
 */
@Injectable()
export class HealthService {
  private readonly endpoints: DependencyEndpoints = loadDependencyEndpoints()

  /** 存活探针：只证明进程在跑，不代表依赖可用。 */
  live(): { status: 'ok'; service: string } {
    return { status: 'ok', service: 'api' }
  }

  /** 就绪探针：逐项探测六个中间件，并发执行以控制总耗时。 */
  async ready(): Promise<HealthReport> {
    const endpoints = this.endpoints
    const dependencies = await Promise.all([
      probePostgres('postgres', { connectionString: endpoints.postgresUrl }),
      probeHttp('opensearch', endpoints.opensearchNode),
      probeTcp('rabbitmq', endpoints.rabbitmqHost, endpoints.rabbitmqPort),
      probeRedis('redis', endpoints.redisHost, endpoints.redisPort),
      probeHttp('minio', `${endpoints.minioEndpoint.replace(/\/+$/, '')}/minio/health/live`),
      probeHttp('keycloak', oidcDiscoveryUrl(endpoints.keycloakBaseUrl, endpoints.keycloakRealm)),
    ])
    return aggregateHealth(dependencies)
  }
}
