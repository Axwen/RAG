import { Inject, Injectable } from '@nestjs/common'
import type { ServerIdentityContext, SessionView } from '@rag/contracts'
import { toSessionView } from '@rag/contracts'
import { loadIdentityContext } from '@rag/database'
import { PrismaService } from '../database/prisma.service'
import type { AuthConfig } from './auth.config'
import { AUTH_CONFIG } from './auth.providers'
import { createPkcePair, createState, safeEqual } from './pkce'
import { OidcClient } from './oidc-client'

/**
 * auth 服务（T14a）：Authorization Code + PKCE 的编排层。
 *
 * 链路：login（拼 authorize URL + PKCE/state）→ Keycloak → callback
 * （换 token → JWKS 校验 iss/sub → loadIdentityContext 装配业务身份）→
 * 签发会话 cookie。
 *
 * 「你能做什么」不在这里：本模块只交付「知道你是谁」（T14 批次划分），
 * 授权判定是 T14b 统一授权入口的职责，任何路由不得从会话快照自判权限。
 */
@Injectable()
export class AuthService {
  private readonly oidc: OidcClient

  constructor(
    @Inject(AUTH_CONFIG) private readonly config: AuthConfig,
    private readonly prisma: PrismaService,
  ) {
    this.oidc = new OidcClient(config)
  }

  /** 第一步：重定向到 Keycloak 的 authorize URL。返回值由控制器 302。 */
  buildLoginRequest(): { authorizeUrl: string; verifier: string; state: string } {
    const { verifier, challenge } = createPkcePair()
    const state = createState()
    const url = new URL(this.config.authorizeUrl)
    url.searchParams.set('client_id', this.config.clientId)
    url.searchParams.set('redirect_uri', this.config.redirectUri)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('scope', 'openid profile email')
    url.searchParams.set('code_challenge', challenge)
    url.searchParams.set('code_challenge_method', 'S256')
    url.searchParams.set('state', state)
    return { authorizeUrl: url.toString(), verifier, state }
  }

  /**
   * 第三步：code → token → 身份上下文。
   * 失败按来源分三类，由控制器映射错误码：
   * - state 不匹配 → INVALID_STATE（CSRF 防线，401）
   * - Keycloak 不可用 → KeycloakUnavailableError（503 DEPENDENCY_UNAVAILABLE）
   * - token 校验失败 / 业务身份不存在或禁用 → Error（401 UNAUTHORIZED）
   */
  async establishIdentity(
    code: string,
    codeVerifier: string,
    expectedState: string | undefined,
    receivedState: string | undefined,
  ): Promise<ServerIdentityContext> {
    if (
      expectedState === undefined ||
      receivedState === undefined ||
      !safeEqual(expectedState, receivedState)
    ) {
      throw new InvalidStateException()
    }
    const tokens = await this.oidc.exchangeCode(code, codeVerifier)
    const claims = await this.oidc.verifyIdToken(tokens.idToken)

    const result = await this.prisma.$transaction((tx) =>
      loadIdentityContext(tx, { issuer: claims.issuer, subject: claims.subject }),
    )
    if (!result.ok) {
      // 未建档或被禁用：对外都是 UNAUTHORIZED，不区分文案——区分即泄漏
      // 「这个外部身份在库里存在且被禁用」。
      throw new IdentityRejectedError(result.reason)
    }
    return result.context
  }

  sessionView(context: ServerIdentityContext): SessionView {
    return toSessionView(context)
  }
}

export class InvalidStateException extends Error {
  constructor() {
    super('登录 state 不匹配，拒绝回调')
    this.name = 'InvalidStateException'
  }
}

export class IdentityRejectedError extends Error {
  constructor(
    readonly reason: 'USER_NOT_FOUND' | 'USER_DISABLED',
  ) {
    super('身份校验未通过')
    this.name = 'IdentityRejectedError'
  }
}
