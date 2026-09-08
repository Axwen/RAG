import { Module } from '@nestjs/common'
import { AuthModule } from './auth/auth.module'
import { AuthorizationModule } from './authorization/authorization.module'
import { HealthModule } from './health/health.module'
import { ManifestsModule } from './manifests/manifests.module'
import { PrismaModule } from './database/prisma.module'

/**
 * API 根模块。
 *
 * T1a 起加入领域模块：全局 Prisma 与 Manifest/Release。T14a 加入 auth
 * （OIDC 接入与业务身份映射），T14b 加入全局 authorization（统一授权
 * 入口）。后续按票据加入：T2 状态命令、T3 Outbox、T6 检索、T7 回答……
 * 模块边界见实施票据。
 */
@Module({
  imports: [PrismaModule, HealthModule, ManifestsModule, AuthModule, AuthorizationModule],
})
export class AppModule {}
