import type { EvidenceLocator, RetrievalCandidate } from '@rag/contracts'

function relevant(candidate: RetrievalCandidate, expected: ReadonlySet<string>): boolean {
  return expected.has(candidate.evidenceId)
}

export function recallAtK(
  expectedEvidenceIds: readonly string[],
  candidates: readonly RetrievalCandidate[],
  k: number,
): number {
  const expected = new Set(expectedEvidenceIds)
  if (expected.size === 0) return 0
  const found = new Set(
    candidates
      .slice(0, Math.max(0, k))
      .filter((candidate) => relevant(candidate, expected))
      .map((candidate) => candidate.evidenceId),
  )
  return found.size / expected.size
}

export function meanReciprocalRank(
  expectedEvidenceIds: readonly string[],
  candidates: readonly RetrievalCandidate[],
): number {
  const expected = new Set(expectedEvidenceIds)
  const first = candidates.findIndex((candidate) => relevant(candidate, expected))
  return first < 0 ? 0 : 1 / (first + 1)
}

export function ndcg(
  expectedEvidenceIds: readonly string[],
  candidates: readonly RetrievalCandidate[],
  k: number,
): number {
  const expected = new Set(expectedEvidenceIds)
  const ranked = candidates.slice(0, Math.max(0, k))
  const seen = new Set<string>()
  const dcg = ranked.reduce((sum, candidate, index) => {
    if (!relevant(candidate, expected) || seen.has(candidate.evidenceId)) return sum
    seen.add(candidate.evidenceId)
    return sum + 1 / Math.log2(index + 2)
  }, 0)
  const idealLength = Math.min(expected.size, Math.max(0, k))
  const ideal = Array.from({ length: idealLength }, (_, index) => 1 / Math.log2(index + 2)).reduce(
    (sum, value) => sum + value,
    0,
  )
  return ideal === 0 ? 0 : dcg / ideal
}

export function correctAssetRate(
  expectedSourceIds: readonly string[],
  candidates: readonly RetrievalCandidate[],
  k: number,
): number {
  if (expectedSourceIds.length === 0) return 0
  const expected = new Set(expectedSourceIds)
  return candidates.slice(0, Math.max(0, k)).some((candidate) => expected.has(candidate.sourceId))
    ? 1
    : 0
}

export function temporalIoU(expected: EvidenceLocator, actual: EvidenceLocator): number {
  if (expected.type !== 'time_range' || actual.type !== 'time_range') return 0
  if (expected.endMs <= expected.startMs || actual.endMs <= actual.startMs) return 0
  const intersection = Math.max(
    0,
    Math.min(expected.endMs, actual.endMs) - Math.max(expected.startMs, actual.startMs),
  )
  if (intersection === 0) return 0
  const union = Math.max(expected.endMs, actual.endMs) - Math.min(expected.startMs, actual.startMs)
  return union === 0 ? 0 : intersection / union
}

export function bestTemporalIoU(
  expected: readonly EvidenceLocator[],
  candidates: readonly RetrievalCandidate[],
  k: number,
): number {
  const actual = candidates.slice(0, Math.max(0, k))
  if (expected.length === 0 || actual.length === 0) return 0
  return Math.max(
    ...expected.flatMap((expectedLocator) =>
      actual.map((candidate) => temporalIoU(expectedLocator, candidate.locator)),
    ),
  )
}
