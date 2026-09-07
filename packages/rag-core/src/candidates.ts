import type { RetrievalCandidate, RetrievalSource } from '@rag/contracts'

const DEFAULT_RRF_CONSTANT = 60
const SOURCE_ORDER: readonly RetrievalSource[] = [
  'lexical',
  'dense',
  'metadata',
  'fusion',
  'rerank',
]

type FusionSource = Exclude<RetrievalSource, 'fusion' | 'rerank'>

export interface CandidateFusionOptions {
  readonly rrfConstant?: number
  readonly sourceWeights?: Partial<Record<FusionSource, number>>
}

function candidateKey(candidate: RetrievalCandidate): string {
  return `${candidate.sourceVersionId}:${candidate.evidenceId}`
}

function sourceOrder(source: RetrievalSource): number {
  return SOURCE_ORDER.indexOf(source)
}

/** 确定性候选排序：不依赖数据库返回顺序或 Map 插入顺序。 */
export function compareCandidates(left: RetrievalCandidate, right: RetrievalCandidate): number {
  const leftScore = Number.isNaN(left.score) ? Number.NEGATIVE_INFINITY : left.score
  const rightScore = Number.isNaN(right.score) ? Number.NEGATIVE_INFINITY : right.score
  if (leftScore !== rightScore) return leftScore > rightScore ? -1 : 1
  if (left.rank !== right.rank) return left.rank - right.rank
  if (left.sourceVersionId !== right.sourceVersionId) {
    return left.sourceVersionId.localeCompare(right.sourceVersionId)
  }
  if (left.evidenceId !== right.evidenceId) return left.evidenceId.localeCompare(right.evidenceId)
  if (left.modality !== right.modality) return left.modality.localeCompare(right.modality)
  if (sourceOrder(left.retrievalSource) !== sourceOrder(right.retrievalSource)) {
    return sourceOrder(left.retrievalSource) - sourceOrder(right.retrievalSource)
  }
  return left.candidateId.localeCompare(right.candidateId)
}

export function sortAndRankCandidates(
  candidates: readonly RetrievalCandidate[],
): readonly RetrievalCandidate[] {
  return [...candidates]
    .sort(compareCandidates)
    .map((candidate, index) => ({ ...candidate, rank: index + 1 }))
}

/** 同一 sourceVersionId + evidenceId 的多路召回只保留一个候选。 */
export function deduplicateCandidates(
  candidates: readonly RetrievalCandidate[],
): readonly RetrievalCandidate[] {
  const selected = new Map<string, RetrievalCandidate>()
  for (const candidate of candidates) {
    const key = candidateKey(candidate)
    const current = selected.get(key)
    if (current === undefined || compareCandidates(candidate, current) < 0) {
      selected.set(key, candidate)
    }
  }
  return sortAndRankCandidates([...selected.values()])
}

/**
 * 使用加权 RRF 合并 lexical/dense/metadata 分路结果。
 * 这是纯逻辑：候选的来源、分数和排序由 Adapter 提供，核心不访问索引。
 */
export function fuseCandidateLists(
  lists: readonly (readonly RetrievalCandidate[])[],
  options: CandidateFusionOptions = {},
): readonly RetrievalCandidate[] {
  const rrfConstant =
    Number.isFinite(options.rrfConstant) && (options.rrfConstant ?? 0) > 0
      ? (options.rrfConstant as number)
      : DEFAULT_RRF_CONSTANT
  const merged = new Map<string, { candidate: RetrievalCandidate; score: number }>()

  for (const list of lists) {
    for (const candidate of list) {
      const weight = Math.max(
        0,
        options.sourceWeights?.[candidate.retrievalSource as FusionSource] ?? 1,
      )
      const contribution = weight / (rrfConstant + Math.max(1, candidate.rank))
      const key = candidateKey(candidate)
      const current = merged.get(key)
      if (current === undefined) {
        merged.set(key, { candidate, score: contribution })
      } else {
        current.score += contribution
        if (compareCandidates(candidate, current.candidate) < 0) current.candidate = candidate
      }
    }
  }

  return sortAndRankCandidates(
    [...merged.values()].map(({ candidate, score }) => ({
      ...candidate,
      retrievalSource: 'fusion' as const,
      score,
      rank: 0,
    })),
  )
}

export interface CandidateDiversityOptions {
  readonly maxPerSourceVersion?: number
  readonly maxPerModality?: number
}

/** 按素材版本和模态限额，避免 Top-K 被单一镜头/单一通道占满。 */
export function diversifyCandidates(
  candidates: readonly RetrievalCandidate[],
  options: CandidateDiversityOptions = {},
): readonly RetrievalCandidate[] {
  const maxPerSourceVersion = Math.max(
    1,
    Math.floor(options.maxPerSourceVersion ?? Number.MAX_SAFE_INTEGER),
  )
  const maxPerModality = Math.max(1, Math.floor(options.maxPerModality ?? Number.MAX_SAFE_INTEGER))
  const sourceCounts = new Map<string, number>()
  const modalityCounts = new Map<RetrievalCandidate['modality'], number>()
  const selected: RetrievalCandidate[] = []

  for (const candidate of sortAndRankCandidates(candidates)) {
    const sourceCount = sourceCounts.get(candidate.sourceVersionId) ?? 0
    const modalityCount = modalityCounts.get(candidate.modality) ?? 0
    if (sourceCount >= maxPerSourceVersion || modalityCount >= maxPerModality) continue
    sourceCounts.set(candidate.sourceVersionId, sourceCount + 1)
    modalityCounts.set(candidate.modality, modalityCount + 1)
    selected.push(candidate)
  }
  return sortAndRankCandidates(selected)
}

/** 应用外部 Reranker 已计算的分数；没有分数的候选保持原分数但排在有分数之后。 */
export function rerankCandidates(
  candidates: readonly RetrievalCandidate[],
  scores: ReadonlyMap<string, number>,
): readonly RetrievalCandidate[] {
  return candidates
    .map((candidate) => {
      const rerankScore = scores.get(candidate.candidateId)
      return {
        candidate:
          rerankScore === undefined
            ? candidate
            : { ...candidate, retrievalSource: 'rerank' as const, score: rerankScore },
        reranked: rerankScore !== undefined,
      }
    })
    .sort((left, right) => {
      if (left.reranked !== right.reranked) return left.reranked ? -1 : 1
      return compareCandidates(left.candidate, right.candidate)
    })
    .map(({ candidate }, index) => ({ ...candidate, rank: index + 1 }))
}
