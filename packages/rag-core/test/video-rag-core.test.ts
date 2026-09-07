import { describe, expect, it } from 'vitest'
import {
  annotateTemporalRelations,
  assembleContext,
  bestTemporalIoU,
  canAcceptProviderResult,
  compareCandidates,
  correctAssetRate,
  deduplicateCandidates,
  diversifyCandidates,
  formatCitation,
  fuseCandidateLists,
  isGroundedAnswer,
  meanReciprocalRank,
  ndcg,
  recallAtK,
  rerankCandidates,
  temporalIoU,
  timeRangeFromLocator,
  temporalRelationBetween,
  validateCitation,
  type GroundedSentence,
} from '../src'
import type { Citation, EvidenceItem, EvidenceLocator, RetrievalCandidate } from '@rag/contracts'

const time = (startMs: number, endMs: number) => ({ type: 'time_range' as const, startMs, endMs })

function candidate(
  candidateId: string,
  evidenceId: string,
  score: number,
  rank: number,
  retrievalSource: RetrievalCandidate['retrievalSource'],
  startMs = 0,
  endMs = 1000,
): RetrievalCandidate {
  return {
    candidateId,
    sourceId: 'asset-1',
    sourceVersionId: 'version-1',
    evidenceId,
    modality: 'speech',
    locator: time(startMs, endMs),
    channelId: retrievalSource === 'dense' ? 'speech-channel@1' : null,
    retrievalSource,
    score,
    rank,
    temporalRelation: { kind: 'none' },
  }
}

const evidence: EvidenceItem = {
  evidenceId: 'evidence-1',
  source: {
    sourceId: 'asset-1',
    sourceKind: 'video',
    sourceVersionId: 'version-1',
    contentHash: 'source-hash',
  },
  level: 'evidence',
  parentEvidenceId: 'shot-1',
  modality: 'speech',
  locator: time(0, 1000),
  text: '可以验证的事实',
  confidence: 0.9,
  language: 'zh',
  speakerRef: null,
  provenance: {
    providerRef: 'video.speech',
    providerVersion: '1',
    modelRef: 'asr',
    modelVersion: '1',
    inputFingerprint: 'input-hash',
    outputFingerprint: 'output-hash',
    runId: 'run-1',
    generation: 1,
    attempt: 1,
    producedAt: '2026-09-04T00:00:00.000Z',
    parentArtifactIds: [],
  },
  contentHash: 'evidence-hash',
  security: { injectionRisk: 'none', availability: 'published' },
}

const citation: Citation = {
  citationId: 'citation-1',
  sentenceIndex: 0,
  evidenceId: evidence.evidenceId,
  sourceId: evidence.source.sourceId,
  sourceVersionId: evidence.source.sourceVersionId,
  locator: evidence.locator,
  status: 'verified',
  verificationMethod: 'locator',
}

describe('候选融合与时间关系', () => {
  it('去重、融合和排序完全确定', () => {
    const lexical = [
      candidate('lexical-1', 'evidence-1', 0.9, 1, 'lexical'),
      candidate('lexical-2', 'evidence-2', 0.8, 2, 'lexical'),
    ]
    const dense = [candidate('dense-1', 'evidence-1', 0.8, 1, 'dense', 2000, 3000)]
    expect(deduplicateCandidates([...lexical, ...dense])).toHaveLength(2)
    const result = fuseCandidateLists([lexical, dense], { sourceWeights: { lexical: 1, dense: 2 } })
    expect(result[0]?.evidenceId).toBe('evidence-1')
    expect(fuseCandidateLists([lexical, dense])).toEqual(fuseCandidateLists([dense, lexical]))
    expect(result.map((item) => item.rank)).toEqual([1, 2])
    expect(fuseCandidateLists([dense], { rrfConstant: 0 })[0]?.score).toBeGreaterThan(0)
    expect(
      diversifyCandidates(
        [candidate('a', 'a', 1, 1, 'dense'), candidate('b', 'b', 0.9, 2, 'dense')],
        { maxPerSourceVersion: 1 },
      ),
    ).toHaveLength(1)
    expect(
      rerankCandidates(
        lexical,
        new Map([
          ['lexical-2', 2],
          ['lexical-1', 1],
        ]),
      )[0]?.candidateId,
    ).toBe('lexical-2')
  })

  it('共享时间 Locator 辅助函数只接受 time_range', () => {
    expect(timeRangeFromLocator(time(0, 1000))).toEqual(time(0, 1000))
    expect(timeRangeFromLocator({ type: 'page_range', startPage: 1, endPage: 1 })).toBeNull()
  })

  it('标注重叠、邻接和无时间关系', () => {
    expect(temporalRelationBetween(time(0, 1000), time(500, 1500))).toEqual({
      kind: 'overlap',
      overlapMs: 500,
    })
    expect(temporalRelationBetween(time(0, 1000), time(2000, 3000), 1000)).toEqual({
      kind: 'adjacent',
      gapMs: 1000,
      direction: 'after',
    })
    expect(
      temporalRelationBetween({ type: 'page_range', startPage: 1, endPage: 1 }, time(0, 1)),
    ).toEqual({ kind: 'none' })
    const annotated = annotateTemporalRelations(
      [
        candidate('a', 'a', 1, 1, 'dense', 0, 1000),
        candidate('b', 'b', 0.9, 2, 'dense', 1500, 2000),
      ],
      500,
    )
    expect(annotated[1]?.temporalRelation.kind).toBe('adjacent')
    expect(
      annotateTemporalRelations([
        candidate('b', 'b', 1, 1, 'dense', 1500, 2000),
        candidate('a', 'a', 1, 1, 'dense', 0, 1000),
      ]).map((item) => item.candidateId),
    ).toEqual(['a', 'b'])
  })
})

describe('上下文与引用', () => {
  it('只组装匹配且可用的证据，去重并跳过阻断项', () => {
    const blocked = {
      ...evidence,
      evidenceId: 'blocked',
      security: { injectionRisk: 'blocked' as const, availability: 'published' as const },
    }
    const result = assembleContext(
      [
        { candidate: candidate('1', evidence.evidenceId, 1, 1, 'dense'), evidence },
        { candidate: candidate('2', evidence.evidenceId, 0.9, 2, 'lexical'), evidence },
        { candidate: candidate('3', blocked.evidenceId, 0.8, 3, 'lexical'), evidence: blocked },
      ],
      { maxItems: 2, maxCharacters: 100 },
    )
    expect(result).toHaveLength(1)
    expect(result[0]?.text).toBe('可以验证的事实')
  })

  it('覆盖每种 Locator 的同值与异值校验', () => {
    const cases: ReadonlyArray<readonly [EvidenceLocator, EvidenceLocator]> = [
      [
        { type: 'page_range', startPage: 1, endPage: 2 },
        { type: 'page_range', startPage: 1, endPage: 3 },
      ],
      [
        { type: 'character_range', start: 0, end: 2 },
        { type: 'character_range', start: 0, end: 3 },
      ],
      [
        { type: 'bbox', page: 1, x: 1, y: 2, width: 3, height: 4 },
        { type: 'bbox', page: 1, x: 1, y: 2, width: 3, height: 5 },
      ],
      [time(0, 1000), time(0, 2000)],
      [
        { type: 'frame', frameNumber: 1, timeMs: 1000 },
        { type: 'frame', frameNumber: 1, timeMs: 2000 },
      ],
      [
        { type: 'image_region', x: 1, y: 2, width: 3, height: 4 },
        { type: 'image_region', x: 1, y: 2, width: 3, height: 5 },
      ],
      [
        { type: 'url_fragment', url: 'https://example.test', selector: 'intro' },
        { type: 'url_fragment', url: 'https://example.test', selector: 'details' },
      ],
    ]

    for (const [locator, differentLocator] of cases) {
      expect(validateCitation({ ...citation, locator }, { ...evidence, locator }).valid).toBe(true)
      expect(
        validateCitation({ ...citation, locator: differentLocator }, { ...evidence, locator })
          .valid,
      ).toBe(false)
    }

    expect(
      validateCitation(
        { ...citation, locator: cases[0]![0] },
        { ...evidence, locator: cases[3]![0] },
      ).valid,
    ).toBe(false)
  })

  it('支持时间、页码和 URL 引用格式，并拒绝错位引用', () => {
    expect(
      formatCitation({
        ...citation,
        locator: { type: 'page_range', startPage: 1, endPage: 1 },
      }),
    ).toContain('p. 1')
    expect(
      formatCitation({
        ...citation,
        locator: { type: 'frame', frameNumber: 12, timeMs: 1000 },
      }),
    ).toContain('frame 12 @ 00:01.000')
    expect(
      formatCitation({
        ...citation,
        locator: { type: 'url_fragment', url: 'https://example.test', selector: 'intro' },
      }),
    ).toBe('[evidence-1] https://example.test#intro')
    expect(formatCitation(citation)).toContain('00:00.000-00:01.000')
    expect(validateCitation(citation, evidence).valid).toBe(true)
    expect(
      validateCitation(
        { ...citation, locator: { endMs: 1000, startMs: 0, type: 'time_range' } },
        evidence,
      ).valid,
    ).toBe(true)
    expect(validateCitation({ ...citation, sourceVersionId: 'other' }, evidence).valid).toBe(false)
    expect(validateCitation({ ...citation, locator: time(1, 2) }, evidence).valid).toBe(false)
    expect(validateCitation({ ...citation, status: 'rejected' }, evidence).valid).toBe(false)
    expect(validateCitation(citation, undefined).valid).toBe(false)
    const sentences: readonly GroundedSentence[] = [{ text: '事实', citations: [citation] }]
    expect(isGroundedAnswer(sentences, new Map([[evidence.evidenceId, evidence]]))).toBe(true)
    expect(isGroundedAnswer([{ text: '无据', citations: [] }], new Map())).toBe(false)
  })
})

describe('评测纯逻辑', () => {
  it('计算 Recall@K、MRR、nDCG、正确素材率和 Temporal IoU', () => {
    const candidates = [
      candidate('1', 'evidence-1', 1, 1, 'dense'),
      candidate('2', 'evidence-2', 0.5, 2, 'lexical'),
    ]
    expect(recallAtK(['evidence-1'], candidates, 1)).toBe(1)
    expect(meanReciprocalRank(['evidence-2'], candidates)).toBe(0.5)
    expect(ndcg(['evidence-1'], candidates, 2)).toBe(1)
    expect(correctAssetRate(['asset-1'], candidates, 1)).toBe(1)
    expect(recallAtK([], candidates, 1)).toBe(0)
    expect(recallAtK(['evidence-1', 'evidence-1'], candidates, 1)).toBe(1)
    expect(ndcg(['evidence-1'], [candidates[0]!, candidates[0]!], 2)).toBe(1)
    expect(temporalIoU(time(0, 1000), time(500, 1500))).toBe(1 / 3)
    expect(temporalIoU({ type: 'page_range', startPage: 1, endPage: 1 }, time(0, 1))).toBe(0)
    expect(bestTemporalIoU([time(0, 1000)], candidates, 1)).toBe(1)
    expect(bestTemporalIoU([], candidates, 1)).toBe(0)
  })
})

describe('旧结果写回门禁', () => {
  const result = { sourceVersionId: evidence.source.sourceVersionId, ...evidence.provenance }
  const current = {
    currentSourceVersionId: evidence.source.sourceVersionId,
    currentRunId: 'run-1',
    currentGeneration: 1,
    currentInputFingerprint: 'input-hash',
    currentAttempt: 1,
    currentStatus: 'running' as const,
  }

  it('只接受相同 run/generation/fingerprint/attempt 的活动结果', () => {
    expect(canAcceptProviderResult(current, result)).toBe(true)
    expect(canAcceptProviderResult({ ...current, currentSourceVersionId: 'other' }, result)).toBe(
      false,
    )
    expect(canAcceptProviderResult({ ...current, currentGeneration: 2 }, result)).toBe(false)
    expect(canAcceptProviderResult({ ...current, currentInputFingerprint: 'new' }, result)).toBe(
      false,
    )
    expect(canAcceptProviderResult({ ...current, currentAttempt: 2 }, result)).toBe(false)
    expect(canAcceptProviderResult({ ...current, currentStatus: 'cancelled' }, result)).toBe(false)
    expect(canAcceptProviderResult({ ...current, currentStatus: 'superseded' }, result)).toBe(false)
  })
})

describe('确定性排序和纯逻辑边界', () => {
  it('按所有稳定字段消解相同分数和特殊分数的并列', () => {
    const base = candidate('z', 'z', 1, 1, 'lexical')
    expect(compareCandidates({ ...base, score: 2 }, base)).toBeLessThan(0)
    expect(
      compareCandidates(
        { ...base, score: Number.NaN, rank: 1 },
        { ...base, score: Number.NaN, rank: 2 },
      ),
    ).toBeLessThan(0)
    expect(
      compareCandidates(
        { ...base, score: Number.NaN, sourceVersionId: 'v-1' },
        { ...base, score: Number.NaN, sourceVersionId: 'v-2' },
      ),
    ).toBeLessThan(0)
    expect(
      compareCandidates(
        { ...base, score: Number.NaN, evidenceId: 'e-1' },
        { ...base, score: Number.NaN, evidenceId: 'e-2' },
      ),
    ).toBeLessThan(0)
    expect(
      compareCandidates(
        { ...base, score: Number.NaN, modality: 'speech' },
        { ...base, score: Number.NaN, modality: 'visual' },
      ),
    ).toBeLessThan(0)
    expect(
      compareCandidates(
        { ...base, score: Number.NaN, retrievalSource: 'lexical' },
        { ...base, score: Number.NaN, retrievalSource: 'dense' },
      ),
    ).toBeLessThan(0)
    expect(
      compareCandidates(
        { ...base, score: Number.NaN, candidateId: 'a' },
        { ...base, score: Number.NaN, candidateId: 'b' },
      ),
    ).toBeLessThan(0)
    expect(
      deduplicateCandidates([
        { ...base, candidateId: 'z', score: Number.NaN, rank: 2 },
        { ...base, candidateId: 'a', score: Number.NaN, rank: 1 },
      ])[0]?.candidateId,
    ).toBe('a')
    expect(
      deduplicateCandidates([
        { ...base, candidateId: 'b', sourceVersionId: 'v-2' },
        { ...base, candidateId: 'a', sourceVersionId: 'v-1' },
      ]),
    ).toHaveLength(2)
    expect(
      deduplicateCandidates([
        { ...base, candidateId: 'b', evidenceId: 'e-2' },
        { ...base, candidateId: 'a', evidenceId: 'e-1' },
      ]),
    ).toHaveLength(2)
    expect(
      deduplicateCandidates([
        { ...base, candidateId: 'b', evidenceId: 'visual-e', modality: 'visual' },
        { ...base, candidateId: 'a', evidenceId: 'speech-e', modality: 'speech' },
      ]),
    ).toHaveLength(2)
  })

  it('处理空列表、无匹配 rerank 分数和多样性限制', () => {
    expect(fuseCandidateLists([])).toEqual([])
    const unrated = rerankCandidates([candidate('a', 'a', 1, 1, 'dense')], new Map())
    expect(unrated[0]?.score).toBe(1)
    expect(unrated[0]?.retrievalSource).toBe('dense')
    expect(
      diversifyCandidates([candidate('a', 'a', 1, 1, 'dense')], { maxPerModality: 0 }),
    ).toHaveLength(1)
    expect(annotateTemporalRelations([candidate('a', 'a', 1, 1, 'dense')])).toHaveLength(1)
  })

  it('格式化每一种引用定位并覆盖上下文过滤分支', () => {
    expect(
      formatCitation({ ...citation, locator: { type: 'page_range', startPage: 1, endPage: 2 } }),
    ).toContain('pp. 1-2')
    expect(
      formatCitation({ ...citation, locator: { type: 'character_range', start: 0, end: 2 } }),
    ).toContain('chars')
    expect(
      formatCitation({
        ...citation,
        locator: { type: 'bbox', page: null, x: 1, y: 2, width: 3, height: 4 },
      }),
    ).toContain('bbox')
    expect(
      formatCitation({
        ...citation,
        locator: { type: 'frame', frameNumber: null, timeMs: 3_600_000 },
      }),
    ).toContain('frame @ 01:00:00.000')
    expect(
      formatCitation({
        ...citation,
        locator: { type: 'image_region', x: 1, y: 2, width: 3, height: 4 },
      }),
    ).toContain('region')
    expect(
      formatCitation({
        ...citation,
        locator: { type: 'url_fragment', url: 'https://example.test', selector: null },
      }),
    ).toBe('[evidence-1] https://example.test')
    const candidateEvidence = {
      ...evidence,
      security: { injectionRisk: 'none' as const, availability: 'candidate' as const },
    }
    expect(
      assembleContext(
        [
          {
            candidate: candidate('a', evidence.evidenceId, 1, 1, 'dense'),
            evidence: candidateEvidence,
          },
        ],
        { maxItems: 0 },
      ),
    ).toEqual([])
    expect(
      assembleContext(
        [
          {
            candidate: candidate('a', evidence.evidenceId, 1, 1, 'dense'),
            evidence: { ...candidateEvidence, text: 'long' },
          },
        ],
        { maxCharacters: 1 },
      ),
    ).toHaveLength(1)
    expect(
      assembleContext([
        { candidate: candidate('a', 'other', 1, 1, 'dense'), evidence: candidateEvidence },
      ]),
    ).toEqual([])
    expect(
      assembleContext([
        {
          candidate: candidate('a', evidence.evidenceId, 1, 1, 'dense'),
          evidence: {
            ...candidateEvidence,
            security: { injectionRisk: 'none', availability: 'deleted' },
          },
        },
      ]),
    ).toEqual([])
  })

  it('处理未命中、空理想集、无交集和空 Top-K 的评测输入', () => {
    const candidates = [candidate('a', 'a', 1, 1, 'dense', 0, 100)]
    expect(meanReciprocalRank(['missing'], candidates)).toBe(0)
    expect(ndcg([], candidates, 1)).toBe(0)
    expect(correctAssetRate([], candidates, 1)).toBe(0)
    expect(correctAssetRate(['other'], candidates, 1)).toBe(0)
    expect(temporalIoU(time(0, 1), time(1, 2))).toBe(0)
    expect(bestTemporalIoU([time(0, 1)], candidates, 0)).toBe(0)
  })
})
