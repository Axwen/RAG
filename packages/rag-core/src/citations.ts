import { isEvidenceLocator } from './contract-validation'
import type {
  Citation,
  CitationValidationResult,
  EvidenceItem,
  EvidenceLocator,
} from '@rag/contracts'

function sameLocator(left: EvidenceLocator, right: EvidenceLocator): boolean {
  if (left.type !== right.type) return false
  switch (left.type) {
    case 'page_range':
      return (
        right.type === 'page_range' &&
        left.startPage === right.startPage &&
        left.endPage === right.endPage
      )
    case 'character_range':
      return (
        right.type === 'character_range' && left.start === right.start && left.end === right.end
      )
    case 'bbox':
      return (
        right.type === 'bbox' &&
        left.page === right.page &&
        left.x === right.x &&
        left.y === right.y &&
        left.width === right.width &&
        left.height === right.height
      )
    case 'time_range':
      return (
        right.type === 'time_range' && left.startMs === right.startMs && left.endMs === right.endMs
      )
    case 'frame':
      return (
        right.type === 'frame' &&
        left.frameNumber === right.frameNumber &&
        left.timeMs === right.timeMs
      )
    case 'image_region':
      return (
        right.type === 'image_region' &&
        left.x === right.x &&
        left.y === right.y &&
        left.width === right.width &&
        left.height === right.height
      )
    case 'url_fragment':
      return (
        right.type === 'url_fragment' && left.url === right.url && left.selector === right.selector
      )
  }
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0')
}

function formatMilliseconds(value: number): string {
  const seconds = Math.floor(value / 1000)
  const milliseconds = value % 1000
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = seconds % 60
  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  const clock =
    hours > 0
      ? `${pad(hours, 2)}:${pad(remainingMinutes, 2)}:${pad(remainingSeconds, 2)}`
      : `${pad(remainingMinutes, 2)}:${pad(remainingSeconds, 2)}`
  return `${clock}.${pad(milliseconds, 3)}`
}

export function formatLocator(locator: Citation['locator']): string {
  switch (locator.type) {
    case 'page_range':
      return locator.startPage === locator.endPage
        ? `p. ${locator.startPage}`
        : `pp. ${locator.startPage}-${locator.endPage}`
    case 'character_range':
      return `chars ${locator.start}-${locator.end}`
    case 'bbox':
      return `bbox(${locator.x},${locator.y},${locator.width},${locator.height})`
    case 'time_range':
      return `${formatMilliseconds(locator.startMs)}-${formatMilliseconds(locator.endMs)}`
    case 'frame':
      return locator.frameNumber === null
        ? `frame @ ${formatMilliseconds(locator.timeMs)}`
        : `frame ${locator.frameNumber} @ ${formatMilliseconds(locator.timeMs)}`
    case 'image_region':
      return `region(${locator.x},${locator.y},${locator.width},${locator.height})`
    case 'url_fragment':
      return locator.selector === null ? locator.url : `${locator.url}#${locator.selector}`
  }
}

export function formatCitation(citation: Citation): string {
  return `[${citation.evidenceId}] ${formatLocator(citation.locator)}`
}

export function validateCitation(
  citation: Citation,
  evidence: EvidenceItem | undefined,
): CitationValidationResult {
  const issues: string[] = []
  if (!isEvidenceLocator(citation.locator)) issues.push('Citation Locator 无效')
  if (evidence === undefined) {
    issues.push('找不到对应 Evidence')
  } else {
    if (citation.evidenceId !== evidence.evidenceId) issues.push('evidenceId 不一致')
    if (citation.sourceId !== evidence.source.sourceId) issues.push('sourceId 不一致')
    if (citation.sourceVersionId !== evidence.source.sourceVersionId) {
      issues.push('sourceVersionId 不一致')
    }
    if (!sameLocator(citation.locator, evidence.locator)) issues.push('Locator 不一致')
    if (evidence.security.availability === 'deleted') issues.push('Evidence 已删除')
    if (evidence.security.availability === 'quarantined') issues.push('Evidence 已隔离')
    if (evidence.security.injectionRisk === 'blocked') issues.push('Evidence 被注入策略阻断')
  }
  if (citation.status === 'rejected') issues.push('Citation 状态为 rejected')
  return { valid: issues.length === 0, issues }
}

export interface GroundedSentence {
  readonly text: string
  readonly citations: readonly Citation[]
}

export function isGroundedAnswer(
  sentences: readonly GroundedSentence[],
  evidenceById: ReadonlyMap<string, EvidenceItem>,
): boolean {
  return sentences.every((sentence) => {
    if (sentence.text.trim().length === 0) return true
    return sentence.citations.some(
      (citation) =>
        citation.status === 'verified' &&
        validateCitation(citation, evidenceById.get(citation.evidenceId)).valid,
    )
  })
}
