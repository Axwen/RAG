/**
 * 公共契约的运行时校验与纯函数辅助逻辑。
 *
 * 领域类型和枚举留在 @rag/contracts；这里负责对外部输入做边界校验，
 * 以保持 contracts 包只承载类型、错误码和注册表。
 */
import { EMBEDDING_DISTANCES, EMBEDDING_MODALITIES, EMBEDDING_NORMALIZATIONS } from '@rag/contracts'
import type {
  EmbeddingChannel,
  EmbeddingValidationIssue,
  EvidenceLocator,
  EvidenceValidationIssue,
  ProviderExecutionIdentity,
  ProviderValidationIssue,
} from '@rag/contracts'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function nonEmptyString(value: unknown): boolean {
  return typeof value === 'string' && value.length > 0
}

function validateRegion(value: Record<string, unknown>, path: string): EvidenceValidationIssue[] {
  const issues: EvidenceValidationIssue[] = []
  for (const key of ['x', 'y', 'width', 'height']) {
    if (!isFiniteNonNegative(value[key])) {
      issues.push({ path: `${path}.${key}`, message: '必须是非负有限数' })
    }
  }
  if (isFiniteNonNegative(value.width) && value.width <= 0) {
    issues.push({ path: `${path}.width`, message: '必须大于 0' })
  }
  if (isFiniteNonNegative(value.height) && value.height <= 0) {
    issues.push({ path: `${path}.height`, message: '必须大于 0' })
  }
  return issues
}

/** 返回所有可诊断的 Locator 约束，不触碰数据库或媒体元数据。 */
export function validateEvidenceLocator(value: unknown): readonly EvidenceValidationIssue[] {
  if (!isRecord(value) || typeof value.type !== 'string') {
    return [{ path: 'locator', message: '必须是带 type 的对象' }]
  }

  switch (value.type) {
    case 'page_range':
      return [
        ...(isPositiveInteger(value.startPage)
          ? []
          : [{ path: 'locator.startPage', message: '必须是正整数' }]),
        ...(isPositiveInteger(value.endPage)
          ? []
          : [{ path: 'locator.endPage', message: '必须是正整数' }]),
        ...(isPositiveInteger(value.startPage) &&
        isPositiveInteger(value.endPage) &&
        value.endPage >= value.startPage
          ? []
          : [{ path: 'locator', message: 'endPage 必须大于或等于 startPage' }]),
      ]
    case 'character_range':
      return [
        ...(isNonNegativeInteger(value.start)
          ? []
          : [{ path: 'locator.start', message: '必须是非负整数' }]),
        ...(isNonNegativeInteger(value.end)
          ? []
          : [{ path: 'locator.end', message: '必须是非负整数' }]),
        ...(isNonNegativeInteger(value.start) &&
        isNonNegativeInteger(value.end) &&
        value.end > value.start
          ? []
          : [{ path: 'locator', message: 'end 必须大于 start' }]),
      ]
    case 'time_range':
      return [
        ...(isNonNegativeInteger(value.startMs)
          ? []
          : [{ path: 'locator.startMs', message: '必须是非负整数毫秒' }]),
        ...(isNonNegativeInteger(value.endMs)
          ? []
          : [{ path: 'locator.endMs', message: '必须是非负整数毫秒' }]),
        ...(isNonNegativeInteger(value.startMs) &&
        isNonNegativeInteger(value.endMs) &&
        value.endMs > value.startMs
          ? []
          : [{ path: 'locator', message: 'endMs 必须大于 startMs' }]),
      ]
    case 'frame':
      return [
        ...(value.frameNumber === null || isNonNegativeInteger(value.frameNumber)
          ? []
          : [{ path: 'locator.frameNumber', message: '必须是 null 或非负整数' }]),
        ...(isNonNegativeInteger(value.timeMs)
          ? []
          : [{ path: 'locator.timeMs', message: '必须是非负整数毫秒' }]),
      ]
    case 'bbox':
    case 'image_region':
      return [
        ...(value.type === 'bbox' && value.page !== null && !isPositiveInteger(value.page)
          ? [{ path: 'locator.page', message: '必须是 null 或正整数' }]
          : []),
        ...validateRegion(value, 'locator'),
      ]
    case 'url_fragment':
      return [
        ...(typeof value.url === 'string' && value.url.length > 0
          ? []
          : [{ path: 'locator.url', message: '必须是非空字符串' }]),
        ...(value.selector === null || typeof value.selector === 'string'
          ? []
          : [{ path: 'locator.selector', message: '必须是 null 或字符串' }]),
      ]
    default:
      return [{ path: 'locator.type', message: `不支持的 Locator 类型：${value.type}` }]
  }
}

export function isEvidenceLocator(value: unknown): value is EvidenceLocator {
  return validateEvidenceLocator(value).length === 0
}

export function timeRangeFromLocator(
  locator: EvidenceLocator,
): { readonly startMs: number; readonly endMs: number } | null {
  return locator.type === 'time_range' ? locator : null
}

export function validateEmbeddingChannel(value: unknown): readonly EmbeddingValidationIssue[] {
  if (!isRecord(value)) return [{ path: 'channel', message: '必须是对象' }]
  const issues: EmbeddingValidationIssue[] = []
  for (const key of ['channelId', 'providerRef', 'modelRef', 'modelVersion']) {
    if (!nonEmptyString(value[key])) {
      issues.push({ path: `channel.${key}`, message: '必须是非空字符串' })
    }
  }
  if (!isPositiveInteger(value.dimension)) {
    issues.push({ path: 'channel.dimension', message: '必须是正整数' })
  }
  if (!EMBEDDING_MODALITIES.includes(value.modality as EmbeddingChannel['modality'])) {
    issues.push({ path: 'channel.modality', message: '不是受支持的 Embedding modality' })
  }
  if (!EMBEDDING_DISTANCES.includes(value.distance as EmbeddingChannel['distance'])) {
    issues.push({ path: 'channel.distance', message: '不是受支持的 distance' })
  }
  if (
    !EMBEDDING_NORMALIZATIONS.includes(value.normalization as EmbeddingChannel['normalization'])
  ) {
    issues.push({ path: 'channel.normalization', message: '不是受支持的 normalization' })
  }
  return issues
}

export function isEmbeddingChannel(value: unknown): value is EmbeddingChannel {
  return validateEmbeddingChannel(value).length === 0
}

export function validateProviderExecutionIdentity(
  value: unknown,
): readonly ProviderValidationIssue[] {
  if (!isRecord(value)) return [{ path: 'identity', message: '必须是对象' }]
  const issues: ProviderValidationIssue[] = []
  for (const key of [
    'sourceVersionId',
    'providerRef',
    'providerVersion',
    'inputFingerprint',
    'runId',
  ]) {
    if (!nonEmptyString(value[key])) {
      issues.push({ path: `identity.${key}`, message: '必须是非空字符串' })
    }
  }
  if (!isNonNegativeInteger(value.generation)) {
    issues.push({ path: 'identity.generation', message: '必须是非负整数' })
  }
  if (!isPositiveInteger(value.attempt)) {
    issues.push({ path: 'identity.attempt', message: '必须是正整数' })
  }
  if (value.modelRef !== null && !nonEmptyString(value.modelRef)) {
    issues.push({ path: 'identity.modelRef', message: '必须是 null 或非空字符串' })
  }
  if (value.modelVersion !== null && !nonEmptyString(value.modelVersion)) {
    issues.push({ path: 'identity.modelVersion', message: '必须是 null 或非空字符串' })
  }
  if ((value.modelRef === null) !== (value.modelVersion === null)) {
    issues.push({
      path: 'identity.model',
      message: 'modelRef 与 modelVersion 必须同时存在或同时为 null',
    })
  }
  return issues
}

export function isProviderExecutionIdentity(value: unknown): value is ProviderExecutionIdentity {
  return validateProviderExecutionIdentity(value).length === 0
}
