import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common'
import type { Request } from 'express'
import { ApiErrorException } from '../common/api-error.exception'
import type { ServerIdentityContext } from '@rag/contracts'
import { parseSessionCookie, readCookie, SESSION_COOKIE_NAME } from './session-cookie'
import type { AuthConfig } from './auth.config'
import { AUTH_CONFIG } from './auth.providers'

/**
 * 身份守卫（T14b / ADR-0039 决策 4）：受保护路由的租户上下文入口。
 *
 * 从会话 cookie 恢复服务端身份上下文，并把租户推导出来挂到请求上——
 * 控制器从此不再接受请求体里的 `tenantId`（T1a 迁移期兼容在本票据退场）。
 *
 * 租户推导规则：优先使用签名会话里的 activeTenantId，并验证它仍在会话的
 * ACTIVE 成员关系中；未选择时仅允许唯一 ACTIVE 租户自动生效。零个或多个
 * 且未选择都 fail closed，不静默取第一个。
 */

/** 挂到请求上的身份与推导出的租户。 */
export interface RequestIdentity {
  readonly context: ServerIdentityContext
  readonly tenantId: string
}

/**
 * 请求上的身份挂载点。不通过 `declare module` 扩充 express 类型（那需要
 * 直接依赖 express-serve-static-core 的路径解析）：控制器用
 * `identityOf(request)` 取值，拿不到就是路由没挂守卫——类型不撒谎。
 */
export function identityOf(request: Request): RequestIdentity {
  const identity = (request as { identity?: RequestIdentity }).identity
  if (identity === undefined) {
    throw new Error('路由缺少 IdentityGuard：request.identity 未设置')
  }
  return identity
}

@Injectable()
export class IdentityGuard implements CanActivate {
  private readonly config: AuthConfig

  constructor(@Inject(AUTH_CONFIG) config: AuthConfig) {
    this.config = config
  }

  canActivate(executionContext: ExecutionContext): boolean {
    const request = executionContext.switchToHttp().getRequest<Request>()
    const parsed = parseSessionCookie(
      readCookie(request.headers.cookie, SESSION_COOKIE_NAME),
      this.config.sessionSecret,
    )
    if (!parsed.ok) {
      // 过期/伪造/缺失统一 401：走信封（ApiErrorException），不是 Nest 默认响应体。
      throw new ApiErrorException('UNAUTHORIZED', '未登录或会话已过期')
    }
    const active = parsed.payload.context.tenantMemberships.filter((m) => m.status === 'ACTIVE')
    if (active.length === 0) {
      throw new ApiErrorException('FORBIDDEN', '当前身份没有活跃的租户成员关系')
    }
    const selectedTenantId = parsed.payload.activeTenantId
    const tenantId =
      selectedTenantId === undefined
        ? active.length === 1
          ? active[0]!.tenantId
          : undefined
        : active.find((membership) => membership.tenantId === selectedTenantId)?.tenantId
    if (tenantId === undefined) {
      throw new ApiErrorException('FORBIDDEN', '请先选择一个活跃租户')
    }
    ;(request as { identity?: RequestIdentity }).identity = {
      context: parsed.payload.context,
      tenantId,
    }
    return true
  }
}
