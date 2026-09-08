import { Injectable } from '@nestjs/common'
import {
  checkIngestionToRelease,
  checkPipelineToRelease,
  checkPipelineTrio,
  compatibilityHashOf,
  contentHashOf,
  type AnswerManifestContent,
  type IngestionManifestContent,
  type PipelineManifestContent,
  type ReleaseManifestContent,
  type RetrievalManifestContent,
} from '@rag/contracts'
import { PrismaService } from '../database/prisma.service'
import { ApiErrorException } from '../common/api-error.exception'
import type {
  AnswerManifestCreateInput,
  IngestionManifestCreateInput,
  PipelineManifestCreateInput,
  ReleaseManifestCreateInput,
  RetrievalManifestCreateInput,
} from './manifests.schemas'

/**
 * Manifest 领域服务（T1a；T14b 起租户上下文由调用方从服务端身份推导传入）。
 *
 * 所有按 id 的读取与写入都带租户谓词（T14 DoD）：跨租户的 id 得到
 * NOT_FOUND 而不是 FORBIDDEN——后者会确认该 id 在别的租户存在。
 *
 * 只提供领域命令：注册（DRAFT）与批准（DRAFT -> APPROVED），不提供通用
 * PATCH status。APPROVED 后内容不可变——字段变化必须新建，数据库
 * (tenantId, contentHash) 唯一约束兜底；同哈希重复注册是幂等操作，
 * 返回已存在的等价对象而不是报错。
 */

type ManifestModel =
  'ingestionManifest' | 'retrievalManifest' | 'answerManifest' | 'pipelineManifest'

@Injectable()
export class ManifestsService {
  constructor(private readonly prisma: PrismaService) {}

  async createIngestion(tenantId: string, input: IngestionManifestCreateInput) {
    const content: IngestionManifestContent = {
      kind: 'ingestion',
      tenantId: tenantId,
      version: input.version,
      parserRef: input.parserRef,
      chunkerRef: input.chunkerRef,
      embeddingRef: input.embeddingRef,
      indexSchemaRef: input.indexSchemaRef,
      parseBackend: input.parseBackend,
      sourceFormats: input.sourceFormats,
    }
    const hash = contentHashOf(content)
    return this.prisma.ingestionManifest
      .create({
        data: {
          tenantId: tenantId,
          version: input.version,
          parserRef: input.parserRef,
          chunkerRef: input.chunkerRef,
          embeddingRef: input.embeddingRef,
          indexSchemaRef: input.indexSchemaRef,
          parseBackend: input.parseBackend,
          sourceFormats: [...input.sourceFormats],
          contentHash: hash,
        },
      })
      .catch(
        idempotentByContentHash(() =>
          this.prisma.ingestionManifest.findFirst({
            where: { tenantId: tenantId, contentHash: hash },
          }),
        ),
      )
  }

  async approveIngestion(tenantId: string, id: string) {
    return this.approve('ingestionManifest', tenantId, id)
  }

  async createRetrieval(tenantId: string, input: RetrievalManifestCreateInput) {
    const content: RetrievalManifestContent = {
      kind: 'retrieval',
      tenantId: tenantId,
      version: input.version,
      sparsePolicy: input.sparsePolicy,
      vectorPolicy: input.vectorPolicy,
      fusionPolicy: input.fusionPolicy,
      rerankerRef: input.rerankerRef,
      candidateBudget: input.candidateBudget,
      rerankInputSize: input.rerankInputSize,
    }
    const hash = contentHashOf(content)
    return this.prisma.retrievalManifest
      .create({
        data: {
          tenantId: tenantId,
          version: input.version,
          sparsePolicy: input.sparsePolicy as object,
          vectorPolicy: input.vectorPolicy as object,
          fusionPolicy: input.fusionPolicy as object,
          rerankerRef: input.rerankerRef,
          candidateBudget: input.candidateBudget,
          rerankInputSize: input.rerankInputSize,
          contentHash: hash,
        },
      })
      .catch(
        idempotentByContentHash(() =>
          this.prisma.retrievalManifest.findFirst({
            where: { tenantId: tenantId, contentHash: hash },
          }),
        ),
      )
  }

  async approveRetrieval(tenantId: string, id: string) {
    return this.approve('retrievalManifest', tenantId, id)
  }

  async createAnswer(tenantId: string, input: AnswerManifestCreateInput) {
    const content: AnswerManifestContent = {
      kind: 'answer',
      tenantId: tenantId,
      version: input.version,
      promptRef: input.promptRef,
      modelRouteRef: input.modelRouteRef,
      citationPolicy: input.citationPolicy,
      riskPolicy: input.riskPolicy,
      fallbackPolicy: input.fallbackPolicy,
    }
    const hash = contentHashOf(content)
    return this.prisma.answerManifest
      .create({
        data: {
          tenantId: tenantId,
          version: input.version,
          promptRef: input.promptRef,
          modelRouteRef: input.modelRouteRef,
          citationPolicy: input.citationPolicy as object,
          riskPolicy: input.riskPolicy as object,
          fallbackPolicy: input.fallbackPolicy as object,
          contentHash: hash,
        },
      })
      .catch(
        idempotentByContentHash(() =>
          this.prisma.answerManifest.findFirst({
            where: { tenantId: tenantId, contentHash: hash },
          }),
        ),
      )
  }

  async approveAnswer(tenantId: string, id: string) {
    return this.approve('answerManifest', tenantId, id)
  }

  /**
   * 创建 Pipeline 组合：先做完整三要素兼容校验（同租户、全 APPROVED、
   * 向量通道与 Embedding 一致），违例时拒绝创建，不落半成品。
   */
  async createPipeline(tenantId: string, input: PipelineManifestCreateInput) {
    const ingestion = await this.requireIngestion(tenantId, input.ingestionManifestId)
    const retrieval = await this.requireRetrieval(tenantId, input.retrievalManifestId)
    const answer = await this.requireAnswer(tenantId, input.answerManifestId)

    if (
      ingestion.tenantId !== tenantId ||
      retrieval.tenantId !== tenantId ||
      answer.tenantId !== tenantId
    ) {
      throw new ApiErrorException(
        'COMPATIBILITY_VIOLATION',
        'Pipeline 请求租户与所引用的 Manifest 不一致',
      )
    }

    const trio = checkPipelineTrio(
      {
        status: ingestion.status,
        content: ingestionContentOf(ingestion),
      },
      {
        status: retrieval.status,
        content: {
          kind: 'retrieval',
          tenantId: retrieval.tenantId,
          version: retrieval.version,
          sparsePolicy: retrieval.sparsePolicy as Record<string, unknown>,
          vectorPolicy: retrieval.vectorPolicy as Record<string, unknown>,
          fusionPolicy: retrieval.fusionPolicy as Record<string, unknown>,
          rerankerRef: retrieval.rerankerRef,
          candidateBudget: retrieval.candidateBudget,
          rerankInputSize: retrieval.rerankInputSize,
        },
      },
      {
        status: answer.status,
        content: {
          kind: 'answer',
          tenantId: answer.tenantId,
          version: answer.version,
          promptRef: answer.promptRef,
          modelRouteRef: answer.modelRouteRef,
          citationPolicy: answer.citationPolicy as Record<string, unknown>,
          riskPolicy: answer.riskPolicy as Record<string, unknown>,
          fallbackPolicy: answer.fallbackPolicy as Record<string, unknown>,
        },
      },
    )
    if (!trio.ok) {
      throw new ApiErrorException(
        'COMPATIBILITY_VIOLATION',
        `兼容组合校验失败：${trio.violations.map((v) => v.message).join('；')}`,
      )
    }

    const content: PipelineManifestContent = {
      kind: 'pipeline',
      tenantId: tenantId,
      version: input.version,
      ingestionManifestId: input.ingestionManifestId,
      retrievalManifestId: input.retrievalManifestId,
      answerManifestId: input.answerManifestId,
    }
    const hash = contentHashOf(content)
    return this.prisma.pipelineManifest
      .create({
        data: {
          tenantId: tenantId,
          version: input.version,
          ingestionManifestId: input.ingestionManifestId,
          retrievalManifestId: input.retrievalManifestId,
          answerManifestId: input.answerManifestId,
          compatibilityHash: compatibilityHashOf({
            ingestion: ingestion.contentHash,
            retrieval: retrieval.contentHash,
            answer: answer.contentHash,
          }),
          contentHash: hash,
        },
      })
      .catch(
        idempotentByContentHash(() =>
          this.prisma.pipelineManifest.findFirst({
            where: { tenantId: tenantId, contentHash: hash },
          }),
        ),
      )
  }

  async approvePipeline(tenantId: string, id: string) {
    return this.approve('pipelineManifest', tenantId, id)
  }

  async findRelease(tenantId: string, id: string) {
    return this.prisma.releaseManifest.findFirst({ where: { id, tenantId } })
  }

  /**
   * 创建 Release（T1a 只落 CREATED 初始态；BUILDING 及之后的迁移由 T5 领域
   * 命令驱动）。校验 Ingestion -> Release 物理字段一致性（§4.3）；同哈希的
   * Release 重复创建是幂等操作。
   */
  async createRelease(tenantId: string, input: ReleaseManifestCreateInput) {
    const ingestion = await this.requireIngestion(tenantId, input.ingestionManifestId)
    const partition = await this.prisma.indexPartition.findFirst({
      where: { id: input.indexPartitionId, tenantId },
    })
    if (partition === null) {
      throw new ApiErrorException('NOT_FOUND', 'IndexPartition 不存在', {
        param: 'indexPartitionId',
      })
    }
    const knowledgeSpace = await this.prisma.knowledgeSpace.findFirst({
      where: { id: input.knowledgeSpaceId, tenantId },
    })
    if (knowledgeSpace === null) {
      throw new ApiErrorException('NOT_FOUND', 'KnowledgeSpace 不存在', {
        param: 'knowledgeSpaceId',
      })
    }
    if (
      ingestion.tenantId !== tenantId ||
      partition.tenantId !== tenantId ||
      partition.knowledgeSpaceId !== input.knowledgeSpaceId ||
      knowledgeSpace.tenantId !== tenantId
    ) {
      throw new ApiErrorException(
        'COMPATIBILITY_VIOLATION',
        'Release 引用的对象不属于同一租户和知识空间',
      )
    }

    const content: ReleaseManifestContent = {
      kind: 'release',
      tenantId: tenantId,
      knowledgeSpaceId: input.knowledgeSpaceId,
      indexPartitionId: input.indexPartitionId,
      ingestionManifestId: input.ingestionManifestId,
      memberSetUri: input.memberSetUri,
      memberSetHash: input.memberSetHash,
      memberCount: input.memberCount,
      docIndexName: input.docIndexName,
      chunkIndexName: input.chunkIndexName,
      candidateAlias: input.candidateAlias,
      indexSchemaVersion: partition.indexSchemaVersion,
      embeddingVersion: partition.embeddingVersion,
    }

    const ingestionResult = checkIngestionToRelease(
      {
        status: ingestion.status,
        content: ingestionContentOf(ingestion),
      },
      { status: 'CREATED', content },
    )
    if (!ingestionResult.ok) {
      throw new ApiErrorException(
        'COMPATIBILITY_VIOLATION',
        `Ingestion -> Release 校验失败：${ingestionResult.violations.map((v) => v.message).join('；')}`,
      )
    }

    // 只按 (tenantId, ingestionManifestId) 取候选，不在查询里过滤 status：状态判定
    // 交给 checkPipelineToRelease，否则那条规则永远为真、变成读起来像安全网的死代码，
    // 且开发者只会看到"没有已批准的兼容 Pipeline"，看不到"存在但还是 DRAFT"。
    const candidates = await this.prisma.pipelineManifest.findMany({
      where: {
        tenantId: tenantId,
        ingestionManifestId: input.ingestionManifestId,
      },
      orderBy: { version: 'desc' },
    })
    const pipeline = candidates.find((row) => row.status === 'APPROVED') ?? candidates[0]
    if (pipeline === undefined) {
      throw new ApiErrorException(
        'COMPATIBILITY_VIOLATION',
        'Release 引用的 IngestionManifest 没有对应的 PipelineManifest',
      )
    }
    const pipelineResult = checkPipelineToRelease(
      {
        status: pipeline.status,
        content: {
          kind: 'pipeline',
          tenantId: pipeline.tenantId,
          version: pipeline.version,
          ingestionManifestId: pipeline.ingestionManifestId,
          retrievalManifestId: pipeline.retrievalManifestId,
          answerManifestId: pipeline.answerManifestId,
        },
      },
      { status: 'CREATED', content },
    )
    if (!pipelineResult.ok) {
      throw new ApiErrorException(
        'COMPATIBILITY_VIOLATION',
        `Pipeline -> Release 校验失败：${pipelineResult.violations.map((v) => v.message).join('；')}`,
      )
    }

    const hash = contentHashOf(content)
    return this.prisma.releaseManifest
      .create({
        data: {
          tenantId: tenantId,
          knowledgeSpaceId: input.knowledgeSpaceId,
          indexPartitionId: input.indexPartitionId,
          ingestionManifestId: input.ingestionManifestId,
          memberSetUri: input.memberSetUri,
          memberSetHash: input.memberSetHash,
          memberCount: input.memberCount,
          docIndexName: input.docIndexName,
          chunkIndexName: input.chunkIndexName,
          candidateAlias: input.candidateAlias,
          indexSchemaVersion: content.indexSchemaVersion,
          embeddingVersion: content.embeddingVersion,
          contentHash: hash,
        },
      })
      .catch(
        idempotentByContentHash(() =>
          this.prisma.releaseManifest.findFirst({
            where: { tenantId: tenantId, contentHash: hash },
          }),
        ),
      )
  }

  /**
   * DRAFT -> APPROVED。
   *
   * 状态判定下推为 UPDATE 的 WHERE 条件，不做"先读后写"：两个并发 approve 都读到
   * DRAFT 时，后一个的 UPDATE 会撞上 APPROVED 不可变触发器
   * （prevent_approved_*_update）抛 check_violation，那是一条裸库错误，只会变成
   * 500 INTERNAL_ERROR。受影响 0 行只可能是"已经是 APPROVED"（id 不存在已由
   * requireManifest 排除），按幂等返回既有行。
   */
  private async approve(model: ManifestModel, tenantId: string, id: string) {
    await this.requireManifest(model, tenantId, id)
    const data = { status: 'APPROVED' as const, approvedAt: new Date() }
    const where = { id, tenantId, status: 'DRAFT' as const }
    // Prisma 的联合模型代理无法直接调用（updateMany/findUnique 签名互不兼容），
    // 按模型分发保持每条分支的精确类型。
    switch (model) {
      case 'ingestionManifest':
        await this.prisma.ingestionManifest.updateMany({ where, data })
        break
      case 'retrievalManifest':
        await this.prisma.retrievalManifest.updateMany({ where, data })
        break
      case 'answerManifest':
        await this.prisma.answerManifest.updateMany({ where, data })
        break
      case 'pipelineManifest':
        await this.prisma.pipelineManifest.updateMany({ where, data })
        break
    }
    return this.requireManifest(model, tenantId, id)
  }

  /** 联合分发：只取回行并校验存在性，调用方拿到的仍是各模型的精确类型。 */
  private async requireManifest(model: ManifestModel, tenantId: string, id: string) {
    switch (model) {
      case 'ingestionManifest':
        return this.requireIngestion(tenantId, id)
      case 'retrievalManifest':
        return this.requireRetrieval(tenantId, id)
      case 'answerManifest':
        return this.requireAnswer(tenantId, id)
      case 'pipelineManifest':
        return this.requirePipeline(tenantId, id)
    }
  }

  private async requireIngestion(tenantId: string, id: string) {
    const found = await this.prisma.ingestionManifest.findFirst({ where: { id, tenantId } })
    if (found === null) {
      throw new ApiErrorException('NOT_FOUND', 'ingestionManifest 不存在', { param: 'id' })
    }
    return found
  }

  private async requireRetrieval(tenantId: string, id: string) {
    const found = await this.prisma.retrievalManifest.findFirst({ where: { id, tenantId } })
    if (found === null) {
      throw new ApiErrorException('NOT_FOUND', 'retrievalManifest 不存在', { param: 'id' })
    }
    return found
  }

  private async requireAnswer(tenantId: string, id: string) {
    const found = await this.prisma.answerManifest.findFirst({ where: { id, tenantId } })
    if (found === null) {
      throw new ApiErrorException('NOT_FOUND', 'answerManifest 不存在', { param: 'id' })
    }
    return found
  }

  private async requirePipeline(tenantId: string, id: string) {
    const found = await this.prisma.pipelineManifest.findFirst({ where: { id, tenantId } })
    if (found === null) {
      throw new ApiErrorException('NOT_FOUND', 'pipelineManifest 不存在', { param: 'id' })
    }
    return found
  }
}

/**
 * 内容寻址的幂等注册：唯一约束冲突时按 (tenantId, contentHash) 找回等价对象。
 * 找不回（例如冲突来自其他唯一键）时转成 409 信封，不向外泄露 Prisma 错误原文。
 */
function idempotentByContentHash(findExisting: () => Promise<unknown>) {
  return async (error: unknown) => {
    if (error instanceof Error && (error as { code?: unknown }).code === 'P2002') {
      const existing = await findExisting()
      if (existing !== null && existing !== undefined) {
        return existing
      }
      throw new ApiErrorException('CONFLICT', '唯一键冲突且无法定位等价对象')
    }
    throw error
  }
}

function ingestionContentOf(row: {
  tenantId: string
  version: number
  parserRef: string
  chunkerRef: string
  embeddingRef: string
  indexSchemaRef: string
  parseBackend: string
  sourceFormats: string[]
}): IngestionManifestContent {
  return {
    kind: 'ingestion',
    tenantId: row.tenantId,
    version: row.version,
    parserRef: row.parserRef,
    chunkerRef: row.chunkerRef,
    embeddingRef: row.embeddingRef,
    indexSchemaRef: row.indexSchemaRef,
    parseBackend: row.parseBackend as IngestionManifestContent['parseBackend'],
    sourceFormats: row.sourceFormats as IngestionManifestContent['sourceFormats'],
  }
}
