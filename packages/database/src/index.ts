/**
 * 数据库访问共享包。
 *
 * 领域模型、仓储与事务边界按票据加入：
 * - T1a：知识空间、文档、Manifest、Release（schema.prisma 已落地）
 * - T2：正交任务状态与幂等命令
 * - T3：Outbox 与事件投递事实
 * - T11a：领域审计的唯一写入口（`writeAuditEvent`）
 * - T12a：模型预算账本的五条事务入口
 * - T14：ACL 主体、授权判定与审计
 *
 * 事务入口只从这里导出：调用方拿到的是 `reserveBudget`/`writeAuditEvent` 这样的函数，
 * 拿不到 `PrismaClient` 也拿不到表结构。业务模块自己拼 SQL 改账本或补审计都是缺陷。
 */
export const DATABASE_PACKAGE = '@rag/database' as const

export * from './audit'
export * from './budget'
export * from './client'
export * from './env'
export * from './health'
export * from './tx'
