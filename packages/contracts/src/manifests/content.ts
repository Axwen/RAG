/**
 * 内容寻址、不可变 Manifest 契约（ADR-0036 §4.2，工程评审闭合记录 §4.2）。
 *
 * 所有 Manifest 都是内容寻址对象：contentHash 由规范化 JSON + SHA-256 计算，
 * (tenantId, contentHash) 在数据库侧唯一。Manifest 只有 DRAFT -> APPROVED 一条
 * 合法迁移；APPROVED 后任何字段变化必须新建，不做原地修改。
 *
 * T1a 只定义租户、知识空间、文档版本、四类 Manifest 与 Release 的字段契约；
 * Chunk 定位（T1b）、状态命令（T2）与事件（T3）按各自票据加入。
 */

/** 数据等级（ADR-0025）。UNKNOWN/SENSITIVE 不得进入云执行区。 */
export const DATA_CLASSES = ['UNKNOWN', 'PUBLIC', 'INTERNAL', 'CONTROLLED', 'SENSITIVE'] as const
export type DataClass = (typeof DATA_CLASSES)[number]

/** Manifest 生命周期：只有 DRAFT -> APPROVED 一条合法迁移。 */
export type ManifestStatus = 'DRAFT' | 'APPROVED'

/**
 * Release 状态（ADR-0036 §4.4）。
 * T1a 只允许创建（CREATED）；后续迁移由 T5 领域命令驱动。
 */
export type ReleaseStatus =
  | 'CREATED'
  | 'BUILDING'
  | 'VALIDATING'
  | 'READY'
  | 'ACTIVE'
  | 'SUPERSEDED'
  | 'ROLLING_BACK'
  | 'FAILED'
  | 'ABORTED'

/** 阶段 1 解析链路唯一后端（ADR-0038）；T4b 增量加入 office_hybrid/image_ocr。 */
export const PARSE_BACKENDS = ['deepdoc'] as const
export type ParseBackend = (typeof PARSE_BACKENDS)[0]

/** T0/T1a 支持的源格式；未列出格式必须显式拒绝（ADR-0038）。 */
export const SOURCE_FORMATS = ['pdf', 'md', 'json', 'csv'] as const
export type SourceFormat = (typeof SOURCE_FORMATS)[number]

/** 语义化引用（parserRef/chunkerRef/embeddingRef 等），如 `deepdoc@1.0.0`。 */
export type ComponentRef = string

export interface IngestionManifestContent {
  readonly kind: 'ingestion'
  readonly tenantId: string
  readonly version: number
  readonly parserRef: ComponentRef
  readonly chunkerRef: ComponentRef
  readonly embeddingRef: ComponentRef
  readonly indexSchemaRef: ComponentRef
  /** 后端标识（ADR-0038）：T1a 默认且仅 deepdoc，契约一次定形。 */
  readonly parseBackend: ParseBackend
  readonly sourceFormats: readonly SourceFormat[]
}

export interface RetrievalManifestContent {
  readonly kind: 'retrieval'
  readonly tenantId: string
  readonly version: number
  readonly sparsePolicy: Readonly<Record<string, unknown>>
  readonly vectorPolicy: Readonly<Record<string, unknown>>
  readonly fusionPolicy: Readonly<Record<string, unknown>>
  readonly rerankerRef: ComponentRef
  /** OpenSearch 融合候选上限（ADR-0035 冻结 1024）。 */
  readonly candidateBudget: number
  /**
   * 实际送入 Reranker 的候选数，与 candidateBudget 分离（PROBE-005）。
   * 必填：进 Manifest 而不是环境变量，否则 RetrievalSnapshot 无法复现一次问答
   * 的真实 rerank 输入规模。开发种子显式写 64。
   */
  readonly rerankInputSize: number
}

export interface AnswerManifestContent {
  readonly kind: 'answer'
  readonly tenantId: string
  readonly version: number
  readonly promptRef: ComponentRef
  readonly modelRouteRef: ComponentRef
  readonly citationPolicy: Readonly<Record<string, unknown>>
  readonly riskPolicy: Readonly<Record<string, unknown>>
  readonly fallbackPolicy: Readonly<Record<string, unknown>>
}

/** PipelineManifest：一个已批准的兼容组合，不是 Release 的父对象（ADR-0036 §4）。 */
export interface PipelineManifestContent {
  readonly kind: 'pipeline'
  readonly tenantId: string
  readonly version: number
  readonly ingestionManifestId: string
  readonly retrievalManifestId: string
  readonly answerManifestId: string
}

/** ReleaseManifest 内容（不含数据库侧 status 等运行态字段）。 */
export interface ReleaseManifestContent {
  readonly kind: 'release'
  readonly tenantId: string
  readonly knowledgeSpaceId: string
  readonly indexPartitionId: string
  readonly ingestionManifestId: string
  readonly memberSetUri: string
  readonly memberSetHash: string
  readonly memberCount: number
  readonly docIndexName: string
  readonly chunkIndexName: string
  readonly candidateAlias: string
  readonly indexSchemaVersion: string
  readonly embeddingVersion: string
}

export type ManifestContent =
  | IngestionManifestContent
  | RetrievalManifestContent
  | AnswerManifestContent
  | PipelineManifestContent
  | ReleaseManifestContent

/** 融合候选上限冻结值（ADR-0035）。 */
export const CANDIDATE_BUDGET_FROZEN = 1024 as const

/** 开发种子的 rerank 输入规模（PROBE-005 待拍板前的实现口径，显式写 64）。 */
export const RERANK_INPUT_SIZE_SEED = 64 as const
