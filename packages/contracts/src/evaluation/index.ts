/** Evaluation 数据集、标注、运行和指标契约（ADR-0044）。 */
import type { EvidenceLocator, EvidenceModality } from '../evidence'

export interface ExpectedEvidence {
  readonly sourceId: string
  readonly sourceVersionId: string
  readonly evidenceId: string | null
  readonly modality: EvidenceModality
  readonly locator: EvidenceLocator
}

export interface EvaluationQuery {
  readonly queryId: string
  readonly text: string | null
  readonly imageArtifactId: string | null
  readonly metadata: Readonly<Record<string, string | number | boolean>>
  readonly expectedEvidence: readonly ExpectedEvidence[]
}

export interface EvaluationDataset {
  readonly datasetId: string
  readonly version: string
  readonly name: string
  readonly queryCount: number
  readonly inputFingerprint: string
  readonly createdAt: string
}

export type EvaluationRunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'

export interface EvaluationRun {
  readonly runId: string
  readonly datasetId: string
  readonly datasetVersion: string
  readonly pipelineRef: string
  readonly inputFingerprint: string
  readonly providerRefs: readonly string[]
  readonly status: EvaluationRunStatus
  readonly startedAt: string
  readonly finishedAt: string | null
}

export interface RetrievalMetrics {
  readonly recallAtK: Readonly<Record<number, number>>
  readonly mrr: number
  readonly ndcg: number
  readonly correctAssetRate: number
}

export interface TemporalMetrics {
  readonly temporalIoUAtK: Readonly<Record<number, number>>
  readonly meanTemporalIoU: number
}

export interface CitationMetrics {
  readonly citationPrecision: number
  readonly groundedAnswerRate: number
}

export interface ResourceMetrics {
  readonly queryLatencyP50Ms: number
  readonly queryLatencyP95Ms: number
  readonly peakMemoryBytes: number
  readonly diskGrowthBytes: number
  readonly cpuTimeMs: number | null
  readonly gpuMemoryBytes: number | null
}

export interface EvaluationResult {
  readonly runId: string
  readonly retrieval: RetrievalMetrics
  readonly temporal: TemporalMetrics
  readonly citation: CitationMetrics
  readonly resources: ResourceMetrics
}
