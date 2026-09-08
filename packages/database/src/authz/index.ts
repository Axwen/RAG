/**
 * 授权层的对外表面（T14b）：能力解析、作用域编译、候选复核与 revision 递增。
 *
 * 与 budget/audit/identity 同一口径：只从包根导出入口，include 形状与
 * 查询结构是实现细节。统一授权入口（apps/api）不直接碰 Prisma 委托。
 */
export * from './bump-acl-revision'
export * from './compile-allowed-scopes'
export * from './recheck-candidates'
export * from './resolve-capabilities'
