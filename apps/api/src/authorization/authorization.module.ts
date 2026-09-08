import { Global, Module } from '@nestjs/common'
import { AuthorizationService } from './authorization.service'

/**
 * 统一授权模块（T14b）：全仓唯一的授权判定入口。
 *
 * 全局模块：受保护路由的 Guard 与领域服务都从这里拿判定，不各自查
 * 成员表或角色表——「没有业务模块绕过统一授权服务」是 T14 DoD，靠
 * 只有这一个 Module 能提供 AuthorizationService 来保证。
 */
@Global()
@Module({
  providers: [AuthorizationService],
  exports: [AuthorizationService],
})
export class AuthorizationModule {}
