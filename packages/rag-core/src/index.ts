/**
 * 检索与回答的纯领域逻辑包。
 *
 * 这里只放不依赖 HTTP 框架、数据库客户端和消息中间件的确定性逻辑，便于单测。
 * T0 只建立包边界与冻结常量入口；行为按票据加入：
 * - T1b：分块与 Chunk 定位
 * - T6：acl_scope_key 编译、候选合并、混合检索融合
 * - T7：Rerank 输入构造与 Top-5 截断
 * - T8：引用验证与蕴含判定分层
 * - T9：确定性冲突判定（模型不参与裁决，ADR-0033）
 */
import { CONTRACTS_SCHEMA_VERSION } from '@rag/contracts'

export const RAG_CORE_PACKAGE = '@rag/rag-core' as const

/** 本包依赖的契约 schema 版本；契约破坏性变更必须在此显式对齐。 */
export const SUPPORTED_CONTRACTS_SCHEMA_VERSION = CONTRACTS_SCHEMA_VERSION

/**
 * 阶段 1 冻结的分块清单标识（PROBE-006 定档，ADR-0031）。
 * 具体参数与实现在 T1b；此处只固定标识，避免各处自行拼字符串。
 */
export const FROZEN_CHUNKING_MANIFEST_ID = 'wide-1024' as const

/** Embedding 向量维度，与 ADR-0017 冻结的 1024 维一致。 */
export const EMBEDDING_DIMENSIONS = 1024 as const

/** Rerank 后返回给用户的引用条数上限。 */
export const RERANK_OUTPUT_TOP_K = 5 as const
