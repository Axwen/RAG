import { createRemoteJWKSet, jwtVerify } from 'jose'
import type { AuthConfig } from './auth.config'

/**
 * Keycloak OIDC 客户端（T14a）：token 交换与 ID token 校验。
 *
 * JWKS 校验与轮换：createRemoteJWKSet 按需拉取并缓存 realm 的 JWKS，
 * 遇到未知 kid 自动重新拉取——Keycloak 轮换签名密钥后第一个新 token
 * 会触发一次重取，旧 token 继续用旧密钥校验，无需重启 API。
 *
 * Keycloak 不可用：网络层错误统一收敛为 KEYCLOAK_UNAVAILABLE，由
 * auth.service 映射 DEPENDENCY_UNAVAILABLE（503）——对外不暴露
 * 连接被拒/超时/DNS 失败的差别，那属于日志（带 trace_id）不属于响应体。
 */

export const KEYCLOAK_UNAVAILABLE = 'KEYCLOAK_UNAVAILABLE' as const

export class KeycloakUnavailableError extends Error {
  readonly code = KEYCLOAK_UNAVAILABLE
  constructor(cause: unknown) {
    super(`Keycloak 不可用：${cause instanceof Error ? cause.message : String(cause)}`)
    this.name = 'KeycloakUnavailableError'
    this.cause = cause
  }
}

export interface OidcTokens {
  readonly idToken: string
  readonly accessToken: string
}

export interface TokenClaims {
  readonly issuer: string
  readonly subject: string
}

/** 用 fetch 收敛网络错误：Keycloak 掉线时抛 KeycloakUnavailableError 而不是 TypeError。 */
async function fetchOrUnavailable(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  let response: Response
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
  } catch (cause) {
    // 连接被拒、DNS 失败、超时（含网络黑洞——SYN 被丢时 fetch 会挂到默认
    // 10 秒以上）都是「依赖不可用」，对调用方是同一个 503。
    throw new KeycloakUnavailableError(cause)
  }
  return response
}

export class OidcClient {
  private readonly jwks: ReturnType<typeof createRemoteJWKSet>
  private readonly config: AuthConfig

  constructor(config: AuthConfig) {
    this.config = config
    this.jwks = createRemoteJWKSet(
      new URL(
        `${config.keycloakBaseUrl}/realms/${config.keycloakRealm}/protocol/openid-connect/certs`,
      ),
    )
  }

  /** Authorization Code + PKCE 换 token。code 一次性、有效期短（Keycloak 默认 60s）。 */
  async exchangeCode(code: string, codeVerifier: string): Promise<OidcTokens> {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: this.config.clientId,
      code,
      redirect_uri: this.config.redirectUri,
      code_verifier: codeVerifier,
    })
    const response = await fetchOrUnavailable(
      this.config.tokenUrl,
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
      },
      this.config.requestTimeoutMs,
    )
    if (!response.ok) {
      // 400 = code 过期/已用/verifier 不符：这是调用方可见的失败，不是依赖不可用。
      const detail = await response.text()
      throw new Error(`token 端点拒绝（HTTP ${response.status}）：${detail.slice(0, 200)}`)
    }
    const json = (await response.json()) as { id_token?: string; access_token?: string }
    if (typeof json.id_token !== 'string' || typeof json.access_token !== 'string') {
      throw new Error('token 端点响应缺少 id_token 或 access_token')
    }
    return { idToken: json.id_token, accessToken: json.access_token }
  }

  /**
   * 校验 ID token 并取出 (iss, sub)：签名走 JWKS，iss 必须等于配置的 issuer，
   * aud 必须是本客户端。exp/nbf 由 jose 默认校验——过期 token 在这里变
   * 401（UNAUTHORIZED），不是 503。
   */
  async verifyIdToken(idToken: string): Promise<TokenClaims> {
    let claims: { iss?: unknown; sub?: unknown }
    try {
      const verified = await jwtVerify(idToken, this.jwks, {
        issuer: this.config.issuer,
        audience: this.config.clientId,
        clockTolerance: 5,
      })
      claims = verified.payload
    } catch (cause) {
      if (cause instanceof KeycloakUnavailableError) throw cause
      throw new Error(
        `ID token 校验失败：${cause instanceof Error ? cause.message : String(cause)}`,
        { cause },
      )
    }
    if (typeof claims.iss !== 'string' || typeof claims.sub !== 'string') {
      throw new Error('ID token 缺少 iss 或 sub 声明')
    }
    return { issuer: claims.iss, subject: claims.sub }
  }
}
