/**
 * 跨模块共享契约包。
 *
 * T0 只建立包边界与构建入口。领域契约按票据顺序加入：
 * - T1a：Manifest、Release、兼容矩阵
 * - T1b：Chunk 定位
 * - T2：正交状态命令
 * - T3：事件与 Outbox
 * - T14：服务端身份上下文与授权结果
 * - T15：ModelCallContext 与用量事实
 */
export const CONTRACTS_PACKAGE = '@rag/contracts' as const

/** 契约包 schema 版本。任何破坏性契约变更必须同时递增此值并记录 ADR。 */
export const CONTRACTS_SCHEMA_VERSION = 0 as const
