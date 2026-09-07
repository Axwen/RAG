/** Embedding Channel 契约（ADR-0042）。维度属于 channel，不是全局 RAG 常量。 */

export const EMBEDDING_MODALITIES = ['text', 'image', 'video_segment', 'multimodal'] as const
export type EmbeddingModality = (typeof EMBEDDING_MODALITIES)[number]

export const EMBEDDING_DISTANCES = ['cosine', 'dot', 'euclidean'] as const
export type EmbeddingDistance = (typeof EMBEDDING_DISTANCES)[number]

export const EMBEDDING_NORMALIZATIONS = ['none', 'l2'] as const
export type EmbeddingNormalization = (typeof EMBEDDING_NORMALIZATIONS)[number]

/** 现有文档 RAG 的 1024 维基线，只是文档 channel 的默认事实。 */
export const DOCUMENT_EMBEDDING_DIMENSION = 1024 as const
export const DOCUMENT_EMBEDDING_CHANNEL_ID = 'document.default@1' as const

export interface EmbeddingChannel {
  readonly channelId: string
  readonly modality: EmbeddingModality
  readonly providerRef: string
  readonly modelRef: string
  readonly modelVersion: string
  readonly dimension: number
  readonly distance: EmbeddingDistance
  readonly normalization: EmbeddingNormalization
}

export interface EmbeddingValidationIssue {
  readonly path: string
  readonly message: string
}
