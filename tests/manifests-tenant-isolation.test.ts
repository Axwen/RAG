import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createPrismaClient, type PrismaClient } from '@rag/database'
import { ManifestsService } from '../apps/api/src/manifests/manifests.service'
import type { PrismaService } from '../apps/api/src/database/prisma.service'
import { ApiErrorException } from '../apps/api/src/common/api-error.exception'

/**
 * Manifests 领域服务的跨租户隔离（T14 DoD / ADR-0039 决策 4）。
 *
 * DoD 原文：「用租户 A 的身份带租户 B 的 id 请求，得到 NOT_FOUND 而不是
 * FORBIDDEN（后者会确认该 id 存在）」。`approve*` 与 `GET /releases/:id`
 * 是 T1a 代码评审点名的两条高危路径：跨租户 approve 会把对方的 Manifest
 * 永久锁成不可变（数据库不可变触发器），跨租户读 Release 会泄漏
 * memberSetUri 与索引名。
 *
 * 这一层必须在真库跑：单元层的 stub 决定不了 WHERE 里有没有租户谓词，
 * 只有真实 PostgreSQL 能证明「id 存在、但在别的租户」时查询确实落空。
 */

let prisma: PrismaClient
let manifests: ManifestsService

/** 每个文件一套独立租户；名字模式清（t14b-iso-*）兼顾自愈历史孤儿。 */
const tenantA = randomUUID() // 请求方（攻击者上下文）
const tenantB = randomUUID() // 数据持有方
const PREFIX = 't14b-iso-'

let ingestionB: { id: string }
let retrievalB: { id: string }
let answerB: { id: string }
let pipelineB: { id: string }
let releaseB: { id: string }

beforeAll(async () => {
  prisma = createPrismaClient()
  manifests = new ManifestsService(prisma as unknown as PrismaService)
  await prisma.tenant.create({ data: { id: tenantA, name: `${PREFIX}a-${tenantA.slice(0, 8)}` } })
  await prisma.tenant.create({ data: { id: tenantB, name: `${PREFIX}b-${tenantB.slice(0, 8)}` } })

  // 租户 B 的完整对象链：四类 DRAFT Manifest + Release 的三 个父对象。
  const spaceB = await prisma.knowledgeSpace.create({
    data: { tenantId: tenantB, slug: 'iso-b', name: '租户B空间' },
  })
  ingestionB = await prisma.ingestionManifest.create({
    data: {
      tenantId: tenantB,
      version: 1,
      parserRef: 'deepdoc@1.0.0',
      chunkerRef: 'wide-1024@1.0.0',
      embeddingRef: 'bge-m3@1.0.0',
      indexSchemaRef: 'index-schema@1',
      sourceFormats: ['pdf'],
      contentHash: `iso-ing-${randomUUID()}`,
    },
    select: { id: true },
  })
  retrievalB = await prisma.retrievalManifest.create({
    data: {
      tenantId: tenantB,
      version: 1,
      sparsePolicy: { analyzer: 'cjk' },
      vectorPolicy: { channels: [] },
      fusionPolicy: {},
      rerankerRef: 'qwen3-reranker-8b@1',
      candidateBudget: 1024,
      rerankInputSize: 64,
      contentHash: `iso-ret-${randomUUID()}`,
    },
    select: { id: true },
  })
  answerB = await prisma.answerManifest.create({
    data: {
      tenantId: tenantB,
      version: 1,
      promptRef: 'answer-prompt@1',
      modelRouteRef: 'gpt-5.6-terra@1',
      citationPolicy: {},
      riskPolicy: {},
      fallbackPolicy: {},
      contentHash: `iso-ans-${randomUUID()}`,
    },
    select: { id: true },
  })
  pipelineB = await prisma.pipelineManifest.create({
    data: {
      tenantId: tenantB,
      version: 1,
      ingestionManifestId: ingestionB.id,
      retrievalManifestId: retrievalB.id,
      answerManifestId: answerB.id,
      compatibilityHash: `iso-com-${randomUUID()}`,
      contentHash: `iso-pipe-${randomUUID()}`,
    },
    select: { id: true },
  })
  const partitionB = await prisma.indexPartition.create({
    data: {
      tenantId: tenantB,
      knowledgeSpaceId: spaceB.id,
      dataClass: 'INTERNAL',
      indexSchemaVersion: 'index-schema@1',
      embeddingVersion: 'bge-m3@1.0.0',
    },
    select: { id: true },
  })
  releaseB = await prisma.releaseManifest.create({
    data: {
      tenantId: tenantB,
      knowledgeSpaceId: spaceB.id,
      indexPartitionId: partitionB.id,
      ingestionManifestId: ingestionB.id,
      memberSetUri: `s3://iso/${randomUUID()}`,
      memberSetHash: `iso-ms-${randomUUID()}`,
      memberCount: 1,
      docIndexName: `iso-doc-${randomUUID().slice(0, 8)}`,
      chunkIndexName: `iso-chunk-${randomUUID().slice(0, 8)}`,
      candidateAlias: `iso-alias-${randomUUID().slice(0, 8)}`,
      indexSchemaVersion: 'index-schema@1',
      embeddingVersion: 'bge-m3@1.0.0',
      contentHash: `iso-rel-${randomUUID()}`,
    },
    select: { id: true },
  })
})

afterAll(async () => {
  const stale = await prisma.tenant.findMany({
    where: { name: { startsWith: PREFIX } },
    select: { id: true },
  })
  const staleIds = stale.map((t) => t.id)
  if (staleIds.length > 0) {
    // 按外键依赖倒序清；不用级联删除，RESTRICT 正是我们要保的性质。
    await prisma.releaseManifest.deleteMany({ where: { tenantId: { in: staleIds } } })
    await prisma.pipelineManifest.deleteMany({ where: { tenantId: { in: staleIds } } })
    await prisma.answerManifest.deleteMany({ where: { tenantId: { in: staleIds } } })
    await prisma.retrievalManifest.deleteMany({ where: { tenantId: { in: staleIds } } })
    await prisma.ingestionManifest.deleteMany({ where: { tenantId: { in: staleIds } } })
    await prisma.indexPartition.deleteMany({ where: { tenantId: { in: staleIds } } })
    await prisma.knowledgeSpace.deleteMany({ where: { tenantId: { in: staleIds } } })
    await prisma.tenant.deleteMany({ where: { id: { in: staleIds } } })
  }
  await prisma.$disconnect()
})

describe('跨租户 id 的租户谓词（T14 DoD）', () => {
  it('四类 approve：租户 A 的身份带租户 B 的 Manifest id → NOT_FOUND', async () => {
    const cases: Array<[name: string, run: () => Promise<unknown>]> = [
      ['ingestion', () => manifests.approveIngestion(tenantA, ingestionB.id)],
      ['retrieval', () => manifests.approveRetrieval(tenantA, retrievalB.id)],
      ['answer', () => manifests.approveAnswer(tenantA, answerB.id)],
      ['pipeline', () => manifests.approvePipeline(tenantA, pipelineB.id)],
    ]
    for (const [name, run] of cases) {
      const error = await run().then(
        () => null,
        (cause: unknown) => cause,
      )
      // FORBIDDEN 会确认 id 在别的租户存在——必须落 NOT_FOUND（信封码断言）。
      expect(error, `${name} 跨租户 approve 必须抛 NOT_FOUND`).toBeInstanceOf(ApiErrorException)
      expect((error as ApiErrorException).envelope.code, name).toBe('NOT_FOUND')
    }
    // 副作用断言：租户 B 的四张 Manifest 仍是 DRAFT，没有被跨租户锁成不可变。
    const [ing, ret, ans, pipe] = await Promise.all([
      prisma.ingestionManifest.findUnique({
        where: { id: ingestionB.id },
        select: { status: true },
      }),
      prisma.retrievalManifest.findUnique({
        where: { id: retrievalB.id },
        select: { status: true },
      }),
      prisma.answerManifest.findUnique({ where: { id: answerB.id }, select: { status: true } }),
      prisma.pipelineManifest.findUnique({ where: { id: pipelineB.id }, select: { status: true } }),
    ])
    expect(ing?.status).toBe('DRAFT')
    expect(ret?.status).toBe('DRAFT')
    expect(ans?.status).toBe('DRAFT')
    expect(pipe?.status).toBe('DRAFT')
  })

  it('GET /releases/:id 对应的 findRelease：租户 A 带租户 B 的 Release id → null（控制器映射 NOT_FOUND）', async () => {
    expect(await manifests.findRelease(tenantA, releaseB.id)).toBeNull()
    // 对照组：同租户读得到，且不泄漏给 A——证明上面的 null 来自租户谓词，
    // 不是数据没造出来。
    const own = await manifests.findRelease(tenantB, releaseB.id)
    expect(own?.id).toBe(releaseB.id)
  })

  it('对照组：同租户 approve 正常走 DRAFT → APPROVED（谓词挡的是跨租户，不是所有人）', async () => {
    const approved = await manifests.approveIngestion(tenantB, ingestionB.id)
    expect(approved.status).toBe('APPROVED')
  })
})
