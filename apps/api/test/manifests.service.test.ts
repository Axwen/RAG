import { describe, expect, it, vi } from 'vitest'
import { ManifestsService } from '../src/manifests/manifests.service'

/**
 * T1a 领域服务的纯逻辑测试：兼容校验与幂等语义，不触数据库。
 * PrismaClient 以最小 stub 注入，只覆盖被调用的方法。
 */

const tenantId = '018f0000-0000-7000-8000-000000000001'
const ingestionId = '018f0000-0000-7000-8000-000000000030'
const retrievalId = '018f0000-0000-7000-8000-000000000031'
const answerId = '018f0000-0000-7000-8000-000000000032'
const partitionId = '018f0000-0000-7000-8000-000000000020'

const ingestionRow = {
  id: ingestionId,
  tenantId,
  version: 1,
  status: 'APPROVED',
  parserRef: 'deepdoc@1.0.0',
  chunkerRef: 'wide-1024@1.0.0',
  embeddingRef: 'bge-m3@1.0.0',
  indexSchemaRef: 'index-schema@1',
  parseBackend: 'deepdoc',
  sourceFormats: ['pdf', 'md'],
  contentHash: 'h-ing',
  approvedAt: new Date(),
  createdAt: new Date(),
}

const retrievalRow = {
  id: retrievalId,
  tenantId,
  version: 1,
  status: 'APPROVED',
  sparsePolicy: { analyzer: 'cjk' },
  vectorPolicy: { channels: [{ name: 'main', embeddingRef: 'bge-m3@1.0.0', dimension: 1024 }] },
  fusionPolicy: {},
  rerankerRef: 'qwen3-reranker-8b@1',
  candidateBudget: 1024,
  rerankInputSize: 64,
  contentHash: 'h-ret',
  approvedAt: new Date(),
  createdAt: new Date(),
}

const answerRow = {
  id: answerId,
  tenantId,
  version: 1,
  status: 'APPROVED',
  promptRef: 'answer-prompt@1',
  modelRouteRef: 'gpt-5.6-terra@1',
  citationPolicy: {},
  riskPolicy: {},
  fallbackPolicy: {},
  contentHash: 'h-ans',
  approvedAt: new Date(),
  createdAt: new Date(),
}

const partitionRow = {
  id: partitionId,
  tenantId,
  knowledgeSpaceId: '018f0000-0000-7000-8000-000000000010',
  dataClass: 'INTERNAL',
  indexSchemaVersion: 'index-schema@1',
  embeddingVersion: 'bge-m3@1.0.0',
  createdAt: new Date(),
}

const knowledgeSpaceRow = {
  id: partitionRow.knowledgeSpaceId,
  tenantId,
}

const pipelineRow = {
  id: '018f0000-0000-7000-8000-000000000033',
  tenantId,
  version: 1,
  status: 'APPROVED',
  ingestionManifestId: ingestionId,
  retrievalManifestId: retrievalId,
  answerManifestId: answerId,
}

/** stub 行的宽松形状：真实行类型由服务侧契约保证，这里只驱动行为。 */
type StubRow = Record<string, unknown>

function makeService(rows: Record<string, StubRow> = {}): ManifestsService {
  const prisma = {
    ingestionManifest: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => rows[where.id] ?? null),
      create: vi.fn(async ({ data }: { data: StubRow }) => ({ id: 'new', ...data })),
    },
    retrievalManifest: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => rows[where.id] ?? null),
      create: vi.fn(async ({ data }: { data: StubRow }) => ({ id: 'new', ...data })),
    },
    answerManifest: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => rows[where.id] ?? null),
      create: vi.fn(async ({ data }: { data: StubRow }) => ({ id: 'new', ...data })),
    },
    releaseManifest: {
      create: vi.fn(async ({ data }: { data: StubRow }) => ({ id: 'new', ...data })),
    },
    knowledgeSpace: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        where.id === knowledgeSpaceRow.id ? knowledgeSpaceRow : null,
      ),
    },
    indexPartition: {
      findUnique: vi.fn(async () => rows[partitionId] ?? null),
    },
    // createRelease requires an already-approved pipeline for the ingestion manifest.
    // Keep this lookup data-driven so the negative path is testable.
    pipelineManifest: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => rows[where.id] ?? null),
      findFirst: vi.fn(async () => rows[pipelineRow.id] ?? null),
      create: vi.fn(async ({ data }: { data: StubRow }) => ({ id: 'new', ...data })),
      update: vi.fn(async ({ data }: { data: StubRow }) => ({
        ...(rows['pipeline-1'] ?? {}),
        ...data,
      })),
    },
  }
  return new ManifestsService(prisma as never)
}

describe('ManifestsService.createPipeline', () => {
  it('三要素全 APPROVED 且向量通道兼容时创建', async () => {
    const service = makeService({
      [ingestionId]: ingestionRow,
      [retrievalId]: retrievalRow,
      [answerId]: answerRow,
    })
    const pipeline = await service.createPipeline({
      tenantId,
      version: 1,
      ingestionManifestId: ingestionId,
      retrievalManifestId: retrievalId,
      answerManifestId: answerId,
    })
    expect(pipeline).toMatchObject({ tenantId, version: 1 })
  })

  it('任一 Manifest 处于 DRAFT 时以 COMPATIBILITY_VIOLATION 拒绝', async () => {
    const service = makeService({
      [ingestionId]: { ...ingestionRow, status: 'DRAFT' },
      [retrievalId]: retrievalRow,
      [answerId]: answerRow,
    })
    await expect(
      service.createPipeline({
        tenantId,
        version: 1,
        ingestionManifestId: ingestionId,
        retrievalManifestId: retrievalId,
        answerManifestId: answerId,
      }),
    ).rejects.toMatchObject({ envelope: { code: 'COMPATIBILITY_VIOLATION' } })
  })

  it('引用不存在的 Manifest 时以 NOT_FOUND 拒绝', async () => {
    const service = makeService({})
    await expect(
      service.createPipeline({
        tenantId,
        version: 1,
        ingestionManifestId: ingestionId,
        retrievalManifestId: retrievalId,
        answerManifestId: answerId,
      }),
    ).rejects.toMatchObject({ envelope: { code: 'NOT_FOUND' } })
  })

  it('请求租户与 Manifest 租户不一致时拒绝', async () => {
    const service = makeService({
      [ingestionId]: ingestionRow,
      [retrievalId]: retrievalRow,
      [answerId]: answerRow,
    })
    await expect(
      service.createPipeline({
        tenantId: '018f0000-0000-7000-8000-000000000099',
        version: 1,
        ingestionManifestId: ingestionId,
        retrievalManifestId: retrievalId,
        answerManifestId: answerId,
      }),
    ).rejects.toMatchObject({ envelope: { code: 'COMPATIBILITY_VIOLATION' } })
  })
})

describe('ManifestsService.createRelease', () => {
  const releaseInput = {
    tenantId,
    knowledgeSpaceId: '018f0000-0000-7000-8000-000000000010',
    indexPartitionId: partitionId,
    ingestionManifestId: ingestionId,
    memberSetUri: 's3://local/ms.json',
    memberSetHash: 'abc',
    memberCount: 3,
    docIndexName: 'docs_v1',
    chunkIndexName: 'chunks_v1',
    candidateAlias: 'candidate_v1',
  }

  it('物理字段一致时创建 Release，版本字段来自分区', async () => {
    const service = makeService({
      [ingestionId]: ingestionRow,
      [partitionId]: partitionRow,
      [pipelineRow.id]: pipelineRow,
    })
    const release = await service.createRelease(releaseInput)
    expect(release).toMatchObject({
      indexSchemaVersion: 'index-schema@1',
      embeddingVersion: 'bge-m3@1.0.0',
    })
    // 初始态 CREATED 由数据库默认值提供：领域命令不写 status，避免绕过状态机
    expect(release).not.toHaveProperty('status')
  })

  it('分区与 Ingestion 的 embeddingVersion 不一致时拒绝', async () => {
    const service = makeService({
      [ingestionId]: ingestionRow,
      [partitionId]: { ...partitionRow, embeddingVersion: 'bge-m3@2.0.0' },
    })
    await expect(service.createRelease(releaseInput)).rejects.toMatchObject({
      envelope: { code: 'COMPATIBILITY_VIOLATION' },
    })
  })

  it('分区不存在时以 NOT_FOUND 拒绝', async () => {
    const service = makeService({ [ingestionId]: ingestionRow })
    await expect(service.createRelease(releaseInput)).rejects.toMatchObject({
      envelope: { code: 'NOT_FOUND', param: 'indexPartitionId' },
    })
  })

  it('没有已批准 Pipeline 时拒绝创建', async () => {
    const service = makeService({
      [ingestionId]: ingestionRow,
      [partitionId]: partitionRow,
    })
    await expect(service.createRelease(releaseInput)).rejects.toMatchObject({
      envelope: { code: 'COMPATIBILITY_VIOLATION' },
    })
  })

  it('分区或知识空间跨租户/空间时拒绝创建', async () => {
    const service = makeService({
      [ingestionId]: ingestionRow,
      [partitionId]: { ...partitionRow, tenantId: '018f0000-0000-7000-8000-000000000099' },
      [pipelineRow.id]: pipelineRow,
    })
    await expect(service.createRelease(releaseInput)).rejects.toMatchObject({
      envelope: { code: 'COMPATIBILITY_VIOLATION' },
    })
  })
})
