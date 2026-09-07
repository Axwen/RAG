/**
 * 跨模态 Evidence 契约（ADR-0041）。
 *
 * SourceKind、SourceAsset 和 AssetVersion 表达来源身份；EvidenceItem 表达可检索、
 * 可引用的证据投影。它们不要求对应某一种数据库表，文档 Chunk 由文档 Adapter
 * 投影为 Evidence，视频 shot/scene/speech/OCR/visual 也使用同一语义。
 */

export const SOURCE_KINDS = ['document', 'web_page', 'video', 'audio', 'image'] as const
export type SourceKind = (typeof SOURCE_KINDS)[number]

export const EVIDENCE_MODALITIES = [
  'text',
  'speech',
  'subtitle',
  'ocr',
  'visual',
  'caption',
  'metadata',
] as const
export type EvidenceModality = (typeof EVIDENCE_MODALITIES)[number]

export const EVIDENCE_LEVELS = ['asset', 'scene', 'shot', 'evidence'] as const
export type EvidenceLevel = (typeof EVIDENCE_LEVELS)[number]

export interface SourceAsset {
  readonly sourceId: string
  readonly kind: SourceKind
  /** 允许为空，资产可能尚未完成 probe。 */
  readonly format: string | null
  readonly title: string | null
  readonly contentHash: string
}

export interface AssetVersion {
  readonly sourceVersionId: string
  readonly sourceId: string
  readonly version: number
  readonly contentHash: string
  readonly createdAt: string
  /** 视频/音频等媒体可提供；文档版本为空。 */
  readonly durationMs: number | null
}

export type EvidenceLocator =
  | {
      readonly type: 'page_range'
      readonly startPage: number
      readonly endPage: number
    }
  | {
      readonly type: 'character_range'
      readonly start: number
      readonly end: number
    }
  | {
      readonly type: 'bbox'
      readonly page: number | null
      readonly x: number
      readonly y: number
      readonly width: number
      readonly height: number
    }
  | {
      readonly type: 'time_range'
      readonly startMs: number
      readonly endMs: number
    }
  | {
      readonly type: 'frame'
      readonly frameNumber: number | null
      readonly timeMs: number
    }
  | {
      readonly type: 'image_region'
      readonly x: number
      readonly y: number
      readonly width: number
      readonly height: number
    }
  | {
      readonly type: 'url_fragment'
      readonly url: string
      readonly selector: string | null
    }

export interface EvidenceSourceRef {
  readonly sourceId: string
  readonly sourceKind: SourceKind
  readonly sourceVersionId: string
  readonly contentHash: string
}

export interface EvidenceProvenance {
  readonly providerRef: string
  readonly providerVersion: string
  readonly modelRef: string | null
  readonly modelVersion: string | null
  readonly inputFingerprint: string
  readonly outputFingerprint: string
  readonly runId: string
  readonly generation: number
  readonly attempt: number
  readonly producedAt: string
  readonly parentArtifactIds: readonly string[]
}

export type InjectionRisk = 'unknown' | 'none' | 'suspected' | 'blocked'
export type EvidenceAvailability = 'candidate' | 'published' | 'quarantined' | 'deleted'

export interface EvidenceSecurity {
  readonly injectionRisk: InjectionRisk
  readonly availability: EvidenceAvailability
}

export interface EvidenceItem {
  readonly evidenceId: string
  readonly source: EvidenceSourceRef
  readonly level: EvidenceLevel
  readonly parentEvidenceId: string | null
  readonly modality: EvidenceModality
  readonly locator: EvidenceLocator
  /** 纯视觉证据可以没有文本；向量不放在这里。 */
  readonly text: string | null
  readonly confidence: number | null
  readonly language: string | null
  readonly speakerRef: string | null
  readonly provenance: EvidenceProvenance
  readonly contentHash: string
  readonly security: EvidenceSecurity
}

export interface EvidenceValidationIssue {
  readonly path: string
  readonly message: string
}
