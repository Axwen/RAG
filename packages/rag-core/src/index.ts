/**
 * 检索与回答的纯领域逻辑包。
 *
 * 本包不依赖 HTTP 框架、数据库客户端、消息中间件、媒体工具或模型 SDK。
 * 文档和 Video RAG 通过 @rag/contracts 进入同一套确定性逻辑；存储、队列和 Provider
 * 由各自 Adapter 实现。
 */
import { CONTRACTS_SCHEMA_VERSION } from '@rag/contracts'

export const RAG_CORE_PACKAGE = '@rag/rag-core' as const

/** 本包依赖的契约 schema 版本；契约破坏性变更必须在此显式对齐。 */
export const SUPPORTED_CONTRACTS_SCHEMA_VERSION = CONTRACTS_SCHEMA_VERSION

/** PROBE-006 冻结的文档分块清单，不是视频或其他模态的分段策略。 */
export const DOCUMENT_CHUNKING_MANIFEST_ID = 'wide-1024' as const

/**
 * @deprecated 使用 DOCUMENT_CHUNKING_MANIFEST_ID；该别名仅保留旧文档 RAG 调用方的源码兼容性。
 */
export const FROZEN_CHUNKING_MANIFEST_ID = DOCUMENT_CHUNKING_MANIFEST_ID

/** Rerank 后返回给用户的引用条数上限。 */
export const RERANK_OUTPUT_TOP_K = 5 as const

export * from './candidates'
export * from './citations'
export * from './context'
export * from './metrics'
export * from './provider-gating'
export * from './temporal'
export * from './contract-validation'
