import { timeRangeFromLocator } from './contract-validation'
import type { EvidenceLocator, RetrievalCandidate, TemporalRelation } from '@rag/contracts'

/** 比较两个 Locator 的时间关系；非时间证据返回 none，不伪造时间。 */
export function temporalRelationBetween(
  left: EvidenceLocator,
  right: EvidenceLocator,
  adjacencyWindowMs = 0,
): TemporalRelation {
  const leftRange = timeRangeFromLocator(left)
  const rightRange = timeRangeFromLocator(right)
  if (leftRange === null || rightRange === null) return { kind: 'none' }

  const overlapMs =
    Math.min(leftRange.endMs, rightRange.endMs) - Math.max(leftRange.startMs, rightRange.startMs)
  if (overlapMs > 0) return { kind: 'overlap', overlapMs }

  const gapMs =
    leftRange.endMs <= rightRange.startMs
      ? rightRange.startMs - leftRange.endMs
      : leftRange.startMs - rightRange.endMs
  if (gapMs <= Math.max(0, adjacencyWindowMs)) {
    return {
      kind: 'adjacent',
      gapMs,
      direction: leftRange.endMs <= rightRange.startMs ? 'after' : 'before',
    }
  }
  return { kind: 'none' }
}

/** 为同一素材版本的候选标注其与最高排序邻居的时间关系。 */
export function annotateTemporalRelations(
  candidates: readonly RetrievalCandidate[],
  adjacencyWindowMs = 5000,
): readonly RetrievalCandidate[] {
  const ranked = [...candidates].sort(
    (left, right) => left.rank - right.rank || left.candidateId.localeCompare(right.candidateId),
  )
  return ranked.map((candidate) => {
    const neighbour = ranked.find(
      (other) =>
        other.candidateId !== candidate.candidateId &&
        other.sourceVersionId === candidate.sourceVersionId,
    )
    if (neighbour === undefined) return { ...candidate, temporalRelation: { kind: 'none' } }
    return {
      ...candidate,
      temporalRelation: temporalRelationBetween(
        neighbour.locator,
        candidate.locator,
        adjacencyWindowMs,
      ),
    }
  })
}
