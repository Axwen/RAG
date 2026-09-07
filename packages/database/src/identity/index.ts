/**
 * 身份层的对外表面（T14a）：按 (issuer, subject) 装配服务端身份上下文。
 *
 * 与 budget/audit 同一口径：只从包根导出入口函数，表结构与 include 形状
 * 是实现细节。auth 模块（apps/api）不直接碰 Prisma 委托。
 */
export * from './load-identity-context'
