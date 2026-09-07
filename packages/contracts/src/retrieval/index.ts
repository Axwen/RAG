/** Retrieval、Candidate 与 Citation 契约（ADR-0041、ADR-0044）。 */
import type { EvidenceLocator, EvidenceModality } from '../evidence'

export const RETRIEVAL_SOURCES = ['lexical', 'dense', 'metadata', 'fusion', 'rerank'] as const
export type RetrievalSource = (typeof RETRIEVAL_SOURCES)[number]

export type TemporalRelation =
  | { readonly kind: 'none' }
  | { readonly kind: 'overlap'; readonly overlapMs: number }
  | {
      readonly kind: 'adjacent'
      readonly gapMs: number
      readonly direction: 'before' | 'after'
    }

export interface RetrievalQuery {
  readonly queryId: string
  readonly text: string | null
  readonly imageArtifactId: string | null
  readonly modalities: readonly EvidenceModality[]
  readonly metadata: Readonly<Record<string, string | number | boolean>>
  readonly topK: number
}

export interface RetrievalCandidate {
  readonly candidateId: string
  readonly sourceId: string
  readonly sourceVersionId: string
  readonly evidenceId: string
  readonly modality: EvidenceModality
  readonly locator: EvidenceLocator
  /** lexical/metadata 候选可为 null，不能伪造向量 channel。 */
  readonly channelId: string | null
  readonly retrievalSource: RetrievalSource
  readonly score: number
  readonly rank: number
  readonly temporalRelation: TemporalRelation
}

export type CitationVerificationStatus = 'unverified' | 'verified' | 'rejected'
export type CitationVerificationMethod = 'locator' | 'provider' | 'manual' | 'none'

export interface Citation {
  readonly citationId: string
  readonly sentenceIndex: number
  readonly evidenceId: string
  readonly sourceId: string
  readonly sourceVersionId: string
  readonly locator: EvidenceLocator
  readonly status: CitationVerificationStatus
  readonly verificationMethod: CitationVerificationMethod
}

export interface CitationValidationResult {
  readonly valid: boolean
  readonly issues: readonly string[]
}
