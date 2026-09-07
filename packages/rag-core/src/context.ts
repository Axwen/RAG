import type { EvidenceItem, RetrievalCandidate } from '@rag/contracts'

export interface ContextInput {
  readonly candidate: RetrievalCandidate
  readonly evidence: EvidenceItem
}

export interface ContextItem {
  readonly evidenceId: string
  readonly sourceId: string
  readonly sourceVersionId: string
  readonly modality: EvidenceItem['modality']
  readonly locator: EvidenceItem['locator']
  readonly text: string | null
  readonly score: number
}

export interface ContextAssemblyOptions {
  readonly maxItems?: number
  readonly maxCharacters?: number
}

/**
 * 组装给上层 Answer/搜索展示使用的证据上下文。
 * 只接受当前可用、未阻断且与候选身份一致的 Evidence，不承担存储或 ACL 查询。
 */
export function assembleContext(
  inputs: readonly ContextInput[],
  options: ContextAssemblyOptions = {},
): readonly ContextItem[] {
  const maxItems = Math.max(0, Math.floor(options.maxItems ?? 10))
  const maxCharacters = Math.max(0, Math.floor(options.maxCharacters ?? 12000))
  const seen = new Set<string>()
  const result: ContextItem[] = []
  let characters = 0

  for (const { candidate, evidence } of [...inputs].sort(
    (left, right) => left.candidate.rank - right.candidate.rank,
  )) {
    if (result.length >= maxItems || seen.has(evidence.evidenceId)) continue
    if (candidate.evidenceId !== evidence.evidenceId) continue
    if (candidate.sourceVersionId !== evidence.source.sourceVersionId) continue
    if (
      evidence.security.availability !== 'candidate' &&
      evidence.security.availability !== 'published'
    )
      continue
    if (evidence.security.injectionRisk === 'blocked') continue
    const textLength = evidence.text?.length ?? 0
    if (characters + textLength > maxCharacters && result.length > 0) continue
    seen.add(evidence.evidenceId)
    result.push({
      evidenceId: evidence.evidenceId,
      sourceId: evidence.source.sourceId,
      sourceVersionId: evidence.source.sourceVersionId,
      modality: evidence.modality,
      locator: evidence.locator,
      text: evidence.text,
      score: candidate.score,
    })
    characters += textLength
  }
  return result
}
