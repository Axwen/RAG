import { Module } from '@nestjs/common'
import { HealthModule } from './health/health.module'
import { ManifestsModule } from './manifests/manifests.module'
import { PrismaModule } from './database/prisma.module'

/**
 * API 根模块。
 *
 * T1a 起加入领域模块：全局 Prisma 与 Manifest/Release。后续按票据加入：
 * T2 状态命令、T3 Outbox、T6 检索、T7 回答、T14 身份与授权……
 * 模块边界见实施票据。
 */
@Module({
  imports: [PrismaModule, HealthModule, ManifestsModule],
})
export class AppModule {}
