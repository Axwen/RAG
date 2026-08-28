import { Module } from '@nestjs/common'
import { HealthModule } from './health/health.module'

/**
 * API 根模块。
 *
 * T0 只装配健康检查。领域模块按票据加入（T1a 知识空间与 Manifest、T2 状态命令、
 * T6 检索、T7 回答、T14 身份与授权……），模块边界见实施票据。
 */
@Module({
  imports: [HealthModule],
})
export class AppModule {}
