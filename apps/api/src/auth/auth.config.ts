import { z } from 'zod'
import { parsePort } from '@rag/config'

/**
 * auth 模块配置（T14a）：启动时一次解析、fail-fast，运行时不从环境热改
 * （与 @rag/config 同一口径）。
 *
 * Keycloak 接入点不在这里重复定义：KEYCLOAK_BASE_URL/KEYCLOAK_REALM 已由
 * dependency-endpoints 解析并被健康检查使用，这里只引用并派生 OIDC 端点。
 */

const authEnvSchema = z.object({
  /** 会话签名密钥：≥32 字节。缺省值仅供本地开发，生产必须显式提供。 */
  AUTH_SESSION_SECRET: z.string().min(32),
  /** 会话 TTL（秒）。到期后 /auth/session 返回 UNAUTHORIZED，需重新登录。 */
  AUTH_SESSION_TTL_SECONDS: z.coerce.number().int().positive().max(86_400).default(3600),
  /** API 自身对外可达的基础 URL：Keycloak 回调地址由它拼出。 */
  AUTH_API_BASE_URL: z.url().default('http://localhost:3001'),
  /** OIDC client_id；rag-api 是 init-keycloak.sh 预建的公共客户端（PKCE）。 */
  AUTH_CLIENT_ID: z.string().min(1).default('rag-api'),
  KEYCLOAK_BASE_URL: z.url().default('http://localhost:8080'),
  KEYCLOAK_REALM: z.string().min(1).default('rag-local'),
})

export interface AuthConfig {
  readonly sessionSecret: string
  readonly sessionTtlSeconds: number
  /** Keycloak 回调地址：/auth/callback。 */
  readonly redirectUri: string
  readonly clientId: string
  readonly keycloakBaseUrl: string
  readonly keycloakRealm: string
  /** ID token 的期望 issuer（iss 声明）。 */
  readonly issuer: string
  /** Authorization 端点与 token 端点（OIDC discovery 的标准路径）。 */
  readonly authorizeUrl: string
  readonly tokenUrl: string
  /** 本地开发兜底密钥：明确标注只限本地，与 .env.example 的说明一致。 */
  readonly isLocalFallbackSecret: boolean
}

const LOCAL_FALLBACK_SECRET = 'local-dev-only-session-secret-32bytes!!'

export function parseAuthConfig(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  const parsed = authEnvSchema.parse({
    AUTH_SESSION_SECRET: env.AUTH_SESSION_SECRET ?? LOCAL_FALLBACK_SECRET,
    AUTH_SESSION_TTL_SECONDS: env.AUTH_SESSION_TTL_SECONDS ?? 3600,
    AUTH_API_BASE_URL: env.AUTH_API_BASE_URL ?? 'http://localhost:3001',
    AUTH_CLIENT_ID: env.AUTH_CLIENT_ID ?? 'rag-api',
    KEYCLOAK_BASE_URL: env.KEYCLOAK_BASE_URL ?? 'http://localhost:8080',
    KEYCLOAK_REALM: env.KEYCLOAK_REALM ?? 'rag-local',
  })
  const base = parsed.KEYCLOAK_BASE_URL.replace(/\/+$/, '')
  const realm = parsed.KEYCLOAK_REALM
  return {
    sessionSecret: parsed.AUTH_SESSION_SECRET,
    sessionTtlSeconds: parsed.AUTH_SESSION_TTL_SECONDS,
    redirectUri: `${parsed.AUTH_API_BASE_URL.replace(/\/+$/, '')}/auth/callback`,
    clientId: parsed.AUTH_CLIENT_ID,
    keycloakBaseUrl: base,
    keycloakRealm: realm,
    issuer: `${base}/realms/${realm}`,
    authorizeUrl: `${base}/realms/${realm}/protocol/openid-connect/auth`,
    tokenUrl: `${base}/realms/${realm}/protocol/openid-connect/token`,
    isLocalFallbackSecret: parsed.AUTH_SESSION_SECRET === LOCAL_FALLBACK_SECRET,
  }
}
