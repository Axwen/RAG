import { Module } from '@nestjs/common'
import { AuthController } from './auth.controller'
import { AuthService } from './auth.service'
import { IdentityGuard } from './identity.guard'
import { AUTH_CONFIG } from './auth.providers'
import { parseAuthConfig } from './auth.config'

/**
 * auth 模块（T14a）：OIDC 接入与业务身份映射。
 *
 * 配置在模块装配时解析一次（fail-fast）：AUTH_SESSION_SECRET 非法或
 * KEYCLOAK_BASE_URL 拼不出 URL，应用起不来，不等到第一次 /auth/login。
 * PrismaService 来自全局 PrismaModule。
 */
@Module({
  providers: [{ provide: AUTH_CONFIG, useFactory: parseAuthConfig }, AuthService, IdentityGuard],
  controllers: [AuthController],
  exports: [IdentityGuard, AUTH_CONFIG],
})
export class AuthModule {}
