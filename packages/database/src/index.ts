/**
 * 数据库访问共享包。
 *
 * 领域模型、仓储与事务边界按票据加入：
 * - T1a：知识空间、文档、Manifest、Release（schema.prisma 已落地）
 * - T2：正交任务状态与幂等命令
 * - T3：Outbox 与事件投递事实
 * - T12：模型预算账本
 * - T14：ACL 主体、授权判定与审计
 */
export const DATABASE_PACKAGE = '@rag/database' as const

export * from './client'
export * from './env'
export * from './health'
