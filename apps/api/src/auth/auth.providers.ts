import type { Provider } from '@nestjs/common'
import type { AuthConfig } from './auth.config'

/**
 * auth 模块的 DI 令牌。单独一个文件而不是散在各处 import 字符串：
 * provide 值与类型只在这一点上对齐。
 */
export const AUTH_CONFIG: unique symbol = Symbol('AUTH_CONFIG')

export type AuthConfigToken = Provider<AuthConfig>
