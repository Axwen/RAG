import { Module } from '@nestjs/common'
import { AuthModule } from '../auth/auth.module'
import { ManifestsController } from './manifests.controller'
import { ManifestsService } from './manifests.service'

/**
 * Manifest/Release 模块（T1a）。
 *
 * 计划文件口径为 apps/api/src/modules/release/；本仓实现把 Manifest 与
 * Release 合并为单一 manifests 模块（ReleaseManifest 本质是入库事实的
 * Manifest，共享注册/批准/兼容校验生命周期），T5 激活协议落地时再拆出
 * release 激活子模块。
 */
@Module({
  // T14b：控制器挂 IdentityGuard，守卫的配置来自 AuthModule。
  imports: [AuthModule],
  controllers: [ManifestsController],
  providers: [ManifestsService],
})
export class ManifestsModule {}
