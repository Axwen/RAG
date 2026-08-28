/**
 * 数据库访问共享包。
 *
 * T0 只固定 schema 位置、迁移命令、连接串来源与健康探测。领域模型、仓储与
 * 事务边界按票据加入：
 * - T1a：知识空间、文档、Manifest、Release
 * - T2：正交任务状态与幂等命令
 * - T3：Outbox 与事件投递事实
 * - T12：模型预算账本
 * - T14：ACL 主体、授权判定与审计
 */
export const DATABASE_PACKAGE = '@rag/database' as const

export * from './env'
export * from './health'
