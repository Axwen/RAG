/**
 * 兼容矩阵（工程评审闭合记录 §4.3，ADR-0036 §4）。
 *
 * 兼容校验是纯函数：输入 Manifest 内容与状态，输出违例列表，不触碰数据库或
 * 网络。调用方（API 领域命令、T5 的激活门槛）据此决定拒绝还是放行；本模块
 * 只负责判定，不负责副作用。
 *
 * T1a 落地四条可静态判定的规则；「Retrieval + Answer -> Workspace」与
 * 「Multi-space Snapshot」依赖 T6/T7 的运行期策略集合，属后续票据。
 */

import type {
  AnswerManifestContent,
  IngestionManifestContent,
  PipelineManifestContent,
  ReleaseManifestContent,
  RetrievalManifestContent,
} from './content'

/** §4.3 兼容矩阵的规则标识，违例必须携带它以便审计归因。 */
export type CompatibilityRule =
  'PIPELINE_TRIO' | 'EMBEDDING_TO_VECTOR_INDEX' | 'PIPELINE_TO_RELEASE' | 'INGESTION_TO_RELEASE'

export interface CompatibilityViolation {
  readonly rule: CompatibilityRule
  readonly message: string
}

export type CompatibilityResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly violations: readonly CompatibilityViolation[] }

const ok: CompatibilityResult = { ok: true }

/**
 * 带 status 的 Manifest 视图：校验只读内容与状态，不读数据库运行态。
 * Release 的 status 是 ReleaseStatus（含 CREATED 等），与 Manifest 的
 * DRAFT/APPROVED 不同生命周期，因此这里用 string 收敛两类。
 */
export interface ManifestWithStatus<C> {
  readonly status: string
  readonly content: C
}

/**
 * Embedding -> Vector Index：RetrievalManifest 的每个向量通道必须声明
 * embeddingRef，且与 IngestionManifest 的 embeddingRef 一致；同一 Manifest 内
 * 通道维度必须一致。不满足时拒绝构建，不允许运行时转换。
 */
export function checkEmbeddingChannels(
  ingestion: ManifestWithStatus<IngestionManifestContent>,
  retrieval: ManifestWithStatus<RetrievalManifestContent>,
): CompatibilityResult {
  const violations: CompatibilityViolation[] = []
  const channels = readVectorChannels(retrieval.content)

  if (channels.length === 0) {
    violations.push({
      rule: 'EMBEDDING_TO_VECTOR_INDEX',
      message: 'retrieval.vectorPolicy.channels 为空：至少需要一个向量通道',
    })
  }
  const dimensions = new Set<string>()
  for (const [index, channel] of channels.entries()) {
    if (channel === null) {
      violations.push({
        rule: 'EMBEDDING_TO_VECTOR_INDEX',
        message: `向量通道 #${index} 不是对象：channels 元素必须形如 { name, embeddingRef, dimension }`,
      })
      continue
    }
    if (channel.embeddingRef !== ingestion.content.embeddingRef) {
      violations.push({
        rule: 'EMBEDDING_TO_VECTOR_INDEX',
        message: `向量通道 ${channel.name ?? '(unnamed)'} 的 embeddingRef ${String(channel.embeddingRef)} 与 IngestionManifest 的 ${ingestion.content.embeddingRef} 不一致`,
      })
    }
    if (channel.dimension === undefined) {
      violations.push({
        rule: 'EMBEDDING_TO_VECTOR_INDEX',
        message: `向量通道 ${channel.name ?? '(unnamed)'} 缺少 dimension`,
      })
    } else {
      dimensions.add(String(channel.dimension))
    }
  }
  if (dimensions.size > 1) {
    violations.push({
      rule: 'EMBEDDING_TO_VECTOR_INDEX',
      message: `同一 RetrievalManifest 内向量通道维度不一致：${[...dimensions].join(', ')}`,
    })
  }
  return violations.length === 0 ? ok : { ok: false, violations }
}

/**
 * Pipeline -> Release：Release 使用的 IngestionManifest 必须能通过已批准兼容组合。
 * Pipeline 不是 Release 的父对象，因此校验方向是「Release 的 ingestionManifestId
 * 出现在某个 APPROVED Pipeline 中」，而不是 Pipeline 包含 Release。
 */
export function checkPipelineToRelease(
  pipeline: ManifestWithStatus<PipelineManifestContent>,
  release: ManifestWithStatus<ReleaseManifestContent>,
): CompatibilityResult {
  const violations: CompatibilityViolation[] = []
  if (pipeline.content.tenantId !== release.content.tenantId) {
    violations.push({
      rule: 'PIPELINE_TO_RELEASE',
      message: 'Pipeline 与 Release 不属于同一租户',
    })
  }
  if (pipeline.status !== 'APPROVED') {
    violations.push({
      rule: 'PIPELINE_TO_RELEASE',
      message: `PipelineManifest 状态为 ${pipeline.status}，只有 APPROVED 组合可用于 Release`,
    })
  }
  if (pipeline.content.ingestionManifestId !== release.content.ingestionManifestId) {
    violations.push({
      rule: 'PIPELINE_TO_RELEASE',
      message: 'Release 引用的 IngestionManifest 不在已批准兼容组合内',
    })
  }
  return violations.length === 0 ? ok : { ok: false, violations }
}

/**
 * Ingestion -> Release：parserRef、chunkerRef、embeddingRef、indexSchemaRef 与
 * Release/分区的物理索引字段一致。不满足时 Release 不能进入 READY。
 *
 * IndexPartition 的 indexSchemaVersion/embeddingVersion 直接使用对应 ref 字符串，
 * 因此这里做全等比较；ref 变化意味着新 Manifest + 新分区，不做部分匹配。
 */
export function checkIngestionToRelease(
  ingestion: ManifestWithStatus<IngestionManifestContent>,
  release: ManifestWithStatus<ReleaseManifestContent>,
): CompatibilityResult {
  const violations: CompatibilityViolation[] = []
  if (ingestion.content.tenantId !== release.content.tenantId) {
    violations.push({
      rule: 'INGESTION_TO_RELEASE',
      message: 'IngestionManifest 与 Release 不属于同一租户',
    })
  }
  if (release.content.embeddingVersion !== ingestion.content.embeddingRef) {
    violations.push({
      rule: 'INGESTION_TO_RELEASE',
      message: `Release 的 embeddingVersion ${release.content.embeddingVersion} 与 IngestionManifest 的 embeddingRef ${ingestion.content.embeddingRef} 不一致`,
    })
  }
  if (release.content.indexSchemaVersion !== ingestion.content.indexSchemaRef) {
    violations.push({
      rule: 'INGESTION_TO_RELEASE',
      message: `Release 的 indexSchemaVersion ${release.content.indexSchemaVersion} 与 IngestionManifest 的 indexSchemaRef ${ingestion.content.indexSchemaRef} 不一致`,
    })
  }
  return violations.length === 0 ? ok : { ok: false, violations }
}

/** Pipeline 组合三要素的完整校验：同租户、全 APPROVED、向量通道与 Embedding 一致。 */
export function checkPipelineTrio(
  ingestion: ManifestWithStatus<IngestionManifestContent>,
  retrieval: ManifestWithStatus<RetrievalManifestContent>,
  answer: ManifestWithStatus<AnswerManifestContent>,
): CompatibilityResult {
  const violations: CompatibilityViolation[] = []
  const tenantIds = new Set([
    ingestion.content.tenantId,
    retrieval.content.tenantId,
    answer.content.tenantId,
  ])
  if (tenantIds.size > 1) {
    violations.push({
      rule: 'PIPELINE_TRIO',
      message: 'Pipeline 组合内的 Manifest 不属于同一租户',
    })
  }
  for (const [label, manifest] of [
    ['ingestion', ingestion],
    ['retrieval', retrieval],
    ['answer', answer],
  ] as const) {
    if (manifest.status !== 'APPROVED') {
      violations.push({
        rule: 'PIPELINE_TRIO',
        message: `${label} Manifest 状态为 ${manifest.status}，只有 APPROVED 的 Manifest 可进入 Pipeline 组合`,
      })
    }
  }
  const embedding = checkEmbeddingChannels(ingestion, retrieval)
  if (!embedding.ok) {
    violations.push(...embedding.violations)
  }
  return violations.length === 0 ? ok : { ok: false, violations }
}

interface VectorChannel {
  readonly name?: string
  readonly embeddingRef?: string
  readonly dimension?: number
}

/**
 * 读取 vectorPolicy.channels。通道结构由契约约定：
 * `[{ name, embeddingRef, dimension }]`。
 *
 * `vectorPolicy` 是自由 Json 列，写入方不止 zod schema 一条路（种子、数据迁移、
 * psql 都能写）。因此这里只做形状归一：整体缺失或不是数组时返回空数组，单个元素
 * 不是对象时返回 `null` 占位——由调用规则报违例，而不是让解引用抛 TypeError 变成
 * 500。
 */
function readVectorChannels(
  retrieval: RetrievalManifestContent,
): readonly (VectorChannel | null)[] {
  const channels = retrieval.vectorPolicy['channels']
  if (!Array.isArray(channels)) {
    return []
  }
  return channels.map((channel) =>
    typeof channel === 'object' && channel !== null && !Array.isArray(channel)
      ? (channel as VectorChannel)
      : null,
  )
}
