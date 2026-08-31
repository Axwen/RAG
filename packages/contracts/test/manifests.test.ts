import { describe, expect, it } from 'vitest'
import {
  type AnswerManifestContent,
  type IngestionManifestContent,
  type ReleaseManifestContent,
  type RetrievalManifestContent,
  contentHashOf,
} from '../src/manifests'
import {
  checkEmbeddingChannels,
  checkIngestionToRelease,
  checkPipelineToRelease,
  checkPipelineTrio,
} from '../src/manifests/compatibility'

const tenantId = '018f0000-0000-7000-8000-000000000001'

const ingestion: IngestionManifestContent = {
  kind: 'ingestion',
  tenantId,
  version: 1,
  parserRef: 'deepdoc@1.0.0',
  chunkerRef: 'wide-1024@1.0.0',
  embeddingRef: 'bge-m3@1.0.0',
  indexSchemaRef: 'index-schema@1',
  parseBackend: 'deepdoc',
  sourceFormats: ['pdf', 'md'],
}

const retrieval: RetrievalManifestContent = {
  kind: 'retrieval',
  tenantId,
  version: 1,
  sparsePolicy: { analyzer: 'cjk' },
  vectorPolicy: { channels: [{ name: 'main', embeddingRef: 'bge-m3@1.0.0', dimension: 1024 }] },
  fusionPolicy: { weights: { sparse: 0.4, vector: 0.6 } },
  rerankerRef: 'qwen3-reranker-8b@1',
  candidateBudget: 1024,
  rerankInputSize: 64,
}

const answer: AnswerManifestContent = {
  kind: 'answer',
  tenantId,
  version: 1,
  promptRef: 'answer-prompt@1',
  modelRouteRef: 'gpt-5.6-terra@1',
  citationPolicy: { scope: 'PERSISTENT' },
  riskPolicy: { highRiskTimeoutMs: 3500 },
  fallbackPolicy: { onConflict: 'PARTIAL' },
}

const release: ReleaseManifestContent = {
  kind: 'release',
  tenantId,
  knowledgeSpaceId: '018f0000-0000-7000-8000-000000000010',
  indexPartitionId: '018f0000-0000-7000-8000-000000000020',
  ingestionManifestId: '018f0000-0000-7000-8000-000000000030',
  memberSetUri: 's3://local/seed/member-set.json',
  memberSetHash: 'abc123',
  memberCount: 3,
  docIndexName: 'rag-local_docs_v1',
  chunkIndexName: 'rag-local_chunks_v1',
  candidateAlias: 'rag-local_candidate_v1',
  indexSchemaVersion: 'index-schema@1',
  embeddingVersion: 'bge-m3@1.0.0',
}

describe('contentHash 规范化', () => {
  it('键顺序与嵌套结构不影响哈希', () => {
    const a = contentHashOf({ ...ingestion, sourceFormats: ['pdf', 'md'] })
    const reordered = {
      sourceFormats: ['pdf', 'md'],
      parseBackend: 'deepdoc',
      tenantId,
      kind: 'ingestion',
      version: 1,
      parserRef: 'deepdoc@1.0.0',
      chunkerRef: 'wide-1024@1.0.0',
      embeddingRef: 'bge-m3@1.0.0',
      indexSchemaRef: 'index-schema@1',
    } as IngestionManifestContent
    expect(contentHashOf(reordered)).toBe(a)
  })

  it('任何字段变化产生不同哈希（rerankInputSize 亦然）', () => {
    expect(contentHashOf({ ...retrieval, rerankInputSize: 128 })).not.toBe(contentHashOf(retrieval))
    expect(contentHashOf({ ...ingestion, parserRef: 'deepdoc@2.0.0' })).not.toBe(
      contentHashOf(ingestion),
    )
  })

  it('数组顺序保留：sourceFormats 顺序不同即不同 Manifest', () => {
    expect(contentHashOf({ ...ingestion, sourceFormats: ['md', 'pdf'] })).not.toBe(
      contentHashOf(ingestion),
    )
  })
})

describe('兼容矩阵（表驱动）', () => {
  const approved = { status: 'APPROVED' as const }

  describe('Embedding -> Vector Index', () => {
    const cases: readonly [string, RetrievalManifestContent, boolean][] = [
      ['通道与 embeddingRef 一致', retrieval, true],
      [
        '通道 embeddingRef 不一致',
        {
          ...retrieval,
          vectorPolicy: {
            channels: [{ name: 'main', embeddingRef: 'text-embedding-3@1', dimension: 1024 }],
          },
        },
        false,
      ],
      [
        '通道缺失 dimension',
        {
          ...retrieval,
          vectorPolicy: { channels: [{ name: 'main', embeddingRef: 'bge-m3@1.0.0' }] },
        },
        false,
      ],
      [
        '同一 Manifest 内维度不一致',
        {
          ...retrieval,
          vectorPolicy: {
            channels: [
              { name: 'main', embeddingRef: 'bge-m3@1.0.0', dimension: 1024 },
              { name: 'aux', embeddingRef: 'bge-m3@1.0.0', dimension: 768 },
            ],
          },
        },
        false,
      ],
      ['channels 缺失', { ...retrieval, vectorPolicy: {} }, false],
    ]

    it.each(cases)('%s -> %s', (_label, manifest, expected) => {
      const result = checkEmbeddingChannels(
        { ...approved, content: ingestion },
        { ...approved, content: manifest },
      )
      expect(result.ok).toBe(expected)
      if (!result.ok) {
        for (const violation of result.violations) {
          expect(violation.rule).toBe('EMBEDDING_TO_VECTOR_INDEX')
        }
      }
    })
  })

  describe('Pipeline -> Release', () => {
    const pipeline = {
      status: 'APPROVED' as const,
      content: {
        kind: 'pipeline' as const,
        tenantId,
        version: 1,
        ingestionManifestId: release.ingestionManifestId,
        retrievalManifestId: '018f0000-0000-7000-8000-000000000031',
        answerManifestId: '018f0000-0000-7000-8000-000000000032',
      },
    }

    it.each([
      ['Release 的 ingestionManifestId 在已批准组合内', pipeline, release, true],
      [
        'Release 引用组合外的 IngestionManifest',
        pipeline,
        { ...release, ingestionManifestId: '018f0000-0000-7000-8000-000000000099' },
        false,
      ],
      ['Pipeline 未批准', { ...pipeline, status: 'DRAFT' as const }, release, false],
      ['跨租户', pipeline, { ...release, tenantId: '018f0000-0000-7000-8000-0000000000ff' }, false],
    ])('%s', (_label, p, r, expected) => {
      const result = checkPipelineToRelease(p, { status: 'CREATED', content: r })
      expect(result.ok).toBe(expected)
    })
  })

  describe('Ingestion -> Release', () => {
    it.each([
      ['物理索引字段一致', release, true],
      ['embeddingVersion 不一致', { ...release, embeddingVersion: 'bge-m3@2.0.0' }, false],
      ['indexSchemaVersion 不一致', { ...release, indexSchemaVersion: 'index-schema@2' }, false],
      ['跨租户', { ...release, tenantId: '018f0000-0000-7000-8000-0000000000ff' }, false],
    ])('%s', (_label, r, expected) => {
      const result = checkIngestionToRelease(
        { ...approved, content: ingestion },
        { status: 'CREATED', content: r },
      )
      expect(result.ok).toBe(expected)
      if (!result.ok) {
        for (const violation of result.violations) {
          expect(violation.rule).toBe('INGESTION_TO_RELEASE')
        }
      }
    })
  })

  describe('Pipeline 三要素组合', () => {
    const ok = checkPipelineTrio(
      { ...approved, content: ingestion },
      { ...approved, content: retrieval },
      { ...approved, content: answer },
    )
    it('全 APPROVED 且通道兼容的组合通过', () => {
      expect(ok.ok).toBe(true)
    })

    it('任一 Manifest 处于 DRAFT 即拒绝', () => {
      const result = checkPipelineTrio(
        { status: 'DRAFT', content: ingestion },
        { ...approved, content: retrieval },
        { ...approved, content: answer },
      )
      expect(result.ok).toBe(false)
    })

    it('组合内租户不一致即拒绝', () => {
      const result = checkPipelineTrio(
        { ...approved, content: ingestion },
        { ...approved, content: retrieval },
        {
          ...approved,
          content: { ...answer, tenantId: '018f0000-0000-7000-8000-0000000000ff' },
        },
      )
      expect(result.ok).toBe(false)
    })
  })
})
