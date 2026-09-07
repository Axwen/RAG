import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common'
import type { CookieOptions, Request, Response } from 'express'
import { ApiErrorException } from '../common/api-error.exception'
import {
  AuthService,
  IdentityRejectedError,
  InvalidStateException,
} from './auth.service'
import { KeycloakUnavailableError } from './oidc-client'
import type { AuthConfig } from './auth.config'
import { AUTH_CONFIG } from './auth.providers'
import {
  PKCE_COOKIE_NAME,
  SESSION_COOKIE_NAME,
  parsePkceCookie,
  parseSessionCookie,
  readCookie,
  signPkceCookie,
  signSession,
} from './session-cookie'

/**
 * /auth 端点（T14a）。
 *
 * 端点形状刻意最小：login（302 到 Keycloak）、callback（建立会话）、
 * session（当前身份投影）、logout（清 cookie）。不提供 refresh：会话到期
 * 重新走 login，刷新链路留给真实需要时再立项——「会话过期」是七类验证
 * 场景之一，语义必须显式而不是被 refresh 静默续掉。
 */
@Controller('auth')
export class AuthController {
  private readonly config: AuthConfig

  constructor(
    @Inject(AUTH_CONFIG) config: AuthConfig,
    private readonly auth: AuthService,
  ) {
    this.config = config
  }

  /** PKCE cookie 只活到回调：登录流程中途放弃不残留。 */
  private readonly pkceCookieOptions: CookieOptions = {
    httpOnly: true,
    sameSite: 'lax',
    secure: false, // 本地 http；TLS 属部署期
    path: '/auth/callback',
    maxAge: 300_000,
  }

  private readonly sessionCookieOptions: CookieOptions = {
    httpOnly: true,
    sameSite: 'lax',
    secure: false,
    path: '/',
  }

  @Get('login')
  login(@Res() res: Response): void {
    const { authorizeUrl, verifier, state } = this.auth.buildLoginRequest()
    res.cookie(
      PKCE_COOKIE_NAME,
      signPkceCookie({ verifier, state }, this.config.sessionSecret),
      this.pkceCookieOptions,
    )
    res.redirect(HttpStatus.FOUND, authorizeUrl)
  }

  @Get('callback')
  async callback(
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Query('error') error: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    // 回调侧清理 PKCE cookie：verifier 是一次性的。
    res.clearCookie(PKCE_COOKIE_NAME, this.pkceCookieOptions)
    if (error !== undefined) {
      // Keycloak 侧拒绝（用户取消、client 配置错误等）：映射 401，不转发 IdP 文案。
      throw new ApiErrorException('UNAUTHORIZED', '身份服务拒绝了本次登录', { param: 'error' })
    }
    if (code === undefined) {
      throw new ApiErrorException('VALIDATION_ERROR', '回调缺少授权码', { param: 'code' })
    }
    const pkce = parsePkceCookie(
      readCookie(res.req.headers.cookie, PKCE_COOKIE_NAME),
      this.config.sessionSecret,
    )
    if (!pkce.ok) {
      // 伪造/过期的回调：没有对应登录发起，直接拒绝。
      throw new ApiErrorException('UNAUTHORIZED', '登录会话不存在或已过期')
    }
    try {
      const context = await this.auth.establishIdentity(code, pkce.payload.verifier, pkce.payload.state, state)
      const expiresAt = Math.floor(Date.now() / 1000) + this.config.sessionTtlSeconds
      res.cookie(
        SESSION_COOKIE_NAME,
        signSession({ context, expiresAt }, this.config.sessionSecret),
        { ...this.sessionCookieOptions, maxAge: this.config.sessionTtlSeconds * 1000 },
      )
      res.status(HttpStatus.OK).json(this.auth.sessionView(context))
    } catch (cause) {
      // 三类失败映射到不同错误码，其余交全局过滤器（INTERNAL_ERROR）：
      // - Keycloak 不可用 → 503 DEPENDENCY_UNAVAILABLE（可重试，调用方应提示稍后再试）
      // - state 不匹配 / token 校验失败 / 身份被拒 → 401 UNAUTHORIZED（重新登录）
      // - 区分对客户端的文案，细节（供应商原文、禁用原因）只进日志。
      if (cause instanceof KeycloakUnavailableError) {
        throw new ApiErrorException('DEPENDENCY_UNAVAILABLE', '身份服务暂不可用，请稍后重试')
      }
      if (cause instanceof InvalidStateException || cause instanceof IdentityRejectedError) {
        throw new ApiErrorException('UNAUTHORIZED', '登录失败，请重新登录')
      }
      if (cause instanceof Error && cause.message.startsWith('ID token 校验失败')) {
        throw new ApiErrorException('UNAUTHORIZED', '登录失败，请重新登录')
      }
      if (cause instanceof Error && cause.message.startsWith('token 端点拒绝')) {
        throw new ApiErrorException('UNAUTHORIZED', '登录失败，请重新登录')
      }
      throw cause
    }
  }

  @Get('session')
  session(@Req() req: Request, @Res() res: Response): void {
    const parsed = parseSessionCookie(
      readCookie(req.headers.cookie, SESSION_COOKIE_NAME),
      this.config.sessionSecret,
    )
    if (!parsed.ok) {
      // 过期、伪造、缺失统一 401：会话过期是七类场景之一，语义在响应码上。
      throw new ApiErrorException('UNAUTHORIZED', '未登录或会话已过期')
    }
    res.status(HttpStatus.OK).json(this.auth.sessionView(parsed.payload.context))
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  logout(@Res() res: Response): void {
    res.clearCookie(SESSION_COOKIE_NAME, this.sessionCookieOptions)
    res.status(HttpStatus.OK).json({ status: 'ok' })
  }
}
