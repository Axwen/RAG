import { randomBytes } from 'node:crypto'
import { loadKeycloakEndpoint } from '@rag/config'
import { z } from 'zod'

/**
 * auth 模块配置（T14a）：启动时一次解析、fail-fast，运行时不从环境热改
 * （与 @rag/config 同一口径）。
 *
 * Keycloak 接入点不在这里重复定义：KEYCLOAK_BASE_URL/KEYCLOAK_REALM 已由
 * dependency-endpoints 解析并被健康检查使用，这里只引用并派生 OIDC 端点。
 */

const authEnvSchema = z.object({
  /** 会话签名密钥：≥32 字节。缺省时仅生成当前进程有效的本地临时密钥。 */
  AUTH_SESSION_SECRET: z.string().min(32),
  /** 会话 TTL（秒）。到期后 /auth/session 返回 UNAUTHORIZED，需重新登录。 */
  AUTH_SESSION_TTL_SECONDS: z.coerce.number().int().positive().max(86_400).default(3600),
  /** API 自身对外可达的基础 URL：Keycloak 回调地址由它拼出。 */
  AUTH_API_BASE_URL: z.url().default('http://localhost:3001'),
  /** OIDC client_id；rag-api 是 init-keycloak.sh 预建的公共客户端（PKCE）。 */
  AUTH_CLIENT_ID: z.string().min(1).default('rag-api'),
  /**
   * 对 Keycloak 的单次 HTTP 超时（毫秒）。不可用有两种形态：连接被拒
   * （立即失败）和网络黑洞（SYN 被丢，fetch 默认要挂 10 秒以上）——
   * 后者必须有显式超时，否则登录请求长时间悬而不决。
   */
  AUTH_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().max(30_000).default(5_000),
})

export interface AuthConfig {
  readonly sessionSecret: string
  readonly sessionTtlSeconds: number
  /** Keycloak 回调地址：/auth/callback。 */
  readonly redirectUri: string
  readonly clientId: string
  readonly keycloakBaseUrl: string
  readonly keycloakRealm: string
  /** 对 Keycloak 的单次 HTTP 超时（毫秒）。 */
  readonly requestTimeoutMs: number
  /** ID token 的期望 issuer（iss 声明）。 */
  readonly issuer: string
  /** Authorization 端点与 token 端点（OIDC discovery 的标准路径）。 */
  readonly authorizeUrl: string
  readonly tokenUrl: string
  /** 未显式配置会话密钥时的本地临时密钥标记；生产环境禁止该路径。 */
  readonly isLocalFallbackSecret: boolean
}

export function parseAuthConfig(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  const isLocalFallbackSecret =
    env.AUTH_SESSION_SECRET === undefined || env.AUTH_SESSION_SECRET === ''
  if (isLocalFallbackSecret && env.NODE_ENV === 'production') {
    throw new Error('生产环境必须显式配置 AUTH_SESSION_SECRET，禁止使用本地临时会话密钥')
  }
  const sessionSecret = isLocalFallbackSecret
    ? randomBytes(32).toString('base64url')
    : env.AUTH_SESSION_SECRET!
  const parsed = authEnvSchema.parse({
    AUTH_SESSION_SECRET: sessionSecret,
    AUTH_SESSION_TTL_SECONDS: env.AUTH_SESSION_TTL_SECONDS ?? 3600,
    AUTH_API_BASE_URL: env.AUTH_API_BASE_URL ?? 'http://localhost:3001',
    AUTH_CLIENT_ID: env.AUTH_CLIENT_ID ?? 'rag-api',
    AUTH_REQUEST_TIMEOUT_MS: env.AUTH_REQUEST_TIMEOUT_MS ?? 5_000,
  })
  const keycloak = loadKeycloakEndpoint(env)
  const base = keycloak.keycloakBaseUrl.replace(/\/+$/, '')
  const realm = keycloak.keycloakRealm
  return {
    sessionSecret: parsed.AUTH_SESSION_SECRET,
    sessionTtlSeconds: parsed.AUTH_SESSION_TTL_SECONDS,
    redirectUri: `${parsed.AUTH_API_BASE_URL.replace(/\/+$/, '')}/auth/callback`,
    clientId: parsed.AUTH_CLIENT_ID,
    keycloakBaseUrl: base,
    keycloakRealm: realm,
    requestTimeoutMs: parsed.AUTH_REQUEST_TIMEOUT_MS,
    issuer: `${base}/realms/${realm}`,
    authorizeUrl: `${base}/realms/${realm}/protocol/openid-connect/auth`,
    tokenUrl: `${base}/realms/${realm}/protocol/openid-connect/token`,
    isLocalFallbackSecret,
  }
}
