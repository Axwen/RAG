import { describe, expect, it } from 'vitest'
import {
  isEmbeddingChannel,
  isEvidenceLocator,
  isProviderExecutionIdentity,
  validateEmbeddingChannel,
  validateEvidenceLocator,
  validateProviderExecutionIdentity,
} from '../src'
import { DOCUMENT_EMBEDDING_DIMENSION, EMBEDDING_MODALITIES } from '@rag/contracts'
import type { ProviderArtifact } from '@rag/contracts'

describe('Video RAG 公共契约', () => {
  it('接受所有定位类型并拒绝非法时间区间', () => {
    const locators = [
      { type: 'page_range', startPage: 1, endPage: 2 },
      { type: 'character_range', start: 0, end: 4 },
      { type: 'bbox', page: 1, x: 0, y: 0, width: 10, height: 20 },
      { type: 'time_range', startMs: 0, endMs: 1000 },
      { type: 'frame', frameNumber: 0, timeMs: 1000 },
      { type: 'image_region', x: 0, y: 0, width: 1, height: 1 },
      { type: 'url_fragment', url: 'https://example.test/doc', selector: 'section-1' },
    ] as const
    for (const locator of locators) expect(isEvidenceLocator(locator)).toBe(true)
    expect(validateEvidenceLocator({ type: 'time_range', startMs: -1, endMs: 0 })).toHaveLength(2)
    expect(isEvidenceLocator({ type: 'time_range', startMs: 10, endMs: 10 })).toBe(false)
    expect(isEvidenceLocator({ type: 'unknown' })).toBe(false)
  })

  it('校验区域、页码、frame 和 URL 边界', () => {
    expect(isEvidenceLocator({ type: 'bbox', page: 0, x: 0, y: 0, width: 0, height: 1 })).toBe(
      false,
    )
    expect(isEvidenceLocator({ type: 'frame', frameNumber: -1, timeMs: 0 })).toBe(false)
    expect(isEvidenceLocator({ type: 'url_fragment', url: '', selector: null })).toBe(false)
    expect(isEvidenceLocator({ type: 'image_region', x: 0, y: 0, width: 1, height: 1 })).toBe(true)
  })

  it('Embedding 维度属于 channel，文档基线仍为 1024', () => {
    expect(DOCUMENT_EMBEDDING_DIMENSION).toBe(1024)
    expect(EMBEDDING_MODALITIES).toContain('video_segment')
    const channel = {
      channelId: 'document.default@1',
      modality: 'text',
      providerRef: 'provider',
      modelRef: 'model',
      modelVersion: '1',
      dimension: 1024,
      distance: 'cosine',
      normalization: 'l2',
    } as const
    expect(isEmbeddingChannel(channel)).toBe(true)
    expect(isEmbeddingChannel({ ...channel, dimension: 768 })).toBe(true)
    expect(validateEmbeddingChannel({ ...channel, dimension: 0 })).not.toHaveLength(0)
    expect(validateEmbeddingChannel({ ...channel, modality: 'audio' })).not.toHaveLength(0)
  })

  it('Artifact 支持 thumbnail 类型', () => {
    const artifact = {
      artifactId: 'artifact-1',
      artifactType: 'thumbnail',
      sourceVersionId: 'version-1',
      providerRef: 'media-engine',
      providerVersion: '1.0.0',
      modelRef: null,
      modelVersion: null,
      inputFingerprint: 'input-hash',
      outputFingerprint: 'output-hash',
      runId: 'run-1',
      generation: 1,
      attempt: 1,
      storageRef: 'artifacts/thumbnail.jpg',
      contentHash: 'sha256:artifact',
      mimeType: 'image/jpeg',
      sizeBytes: 42,
      producedAt: '2026-09-05T00:00:00.000Z',
    } satisfies ProviderArtifact
    expect(artifact.artifactType).toBe('thumbnail')
  })

  it('Provider identity 要求 generation、attempt 和指纹', () => {
    const identity = {
      sourceVersionId: 'version-1',
      providerRef: 'video.speech',
      providerVersion: '1.0.0',
      modelRef: 'asr',
      modelVersion: '1',
      inputFingerprint: 'input-hash',
      runId: 'run-1',
      generation: 2,
      attempt: 1,
    } as const
    expect(isProviderExecutionIdentity(identity)).toBe(true)
    expect(isProviderExecutionIdentity({ ...identity, generation: -1 })).toBe(false)
    expect(validateProviderExecutionIdentity({ ...identity, attempt: 0 })).not.toHaveLength(0)
    expect(validateProviderExecutionIdentity({ ...identity, modelRef: '' })).not.toHaveLength(0)
  })
})

describe('公共契约边界分支', () => {
  it('覆盖 Locator 的空对象、分页、字符、时间、区域和 URL 错误', () => {
    expect(validateEvidenceLocator(null)).toHaveLength(1)
    expect(validateEvidenceLocator({ type: 'page_range', startPage: 0, endPage: 0 })).toHaveLength(
      3,
    )
    expect(validateEvidenceLocator({ type: 'page_range', startPage: 2, endPage: 1 })).toHaveLength(
      1,
    )
    expect(validateEvidenceLocator({ type: 'character_range', start: -1, end: 0 })).toHaveLength(2)
    expect(validateEvidenceLocator({ type: 'character_range', start: 2, end: 1 })).toHaveLength(1)
    expect(validateEvidenceLocator({ type: 'time_range', startMs: 0, endMs: 0 })).toHaveLength(1)
    expect(validateEvidenceLocator({ type: 'frame', frameNumber: null, timeMs: 0 })).toHaveLength(0)
    expect(validateEvidenceLocator({ type: 'frame', frameNumber: 1.5, timeMs: -1 })).toHaveLength(2)
    expect(
      validateEvidenceLocator({ type: 'bbox', page: 0, x: -1, y: Number.NaN, width: 0, height: 0 }),
    ).toHaveLength(5)
    expect(
      validateEvidenceLocator({ type: 'image_region', x: 0, y: 0, width: 1, height: 1 }),
    ).toHaveLength(0)
    expect(validateEvidenceLocator({ type: 'url_fragment', url: 'u', selector: 1 })).toHaveLength(1)
  })

  it('覆盖 Channel 和 Provider identity 的缺失字段与枚举边界', () => {
    const channel = {
      channelId: 'c',
      modality: 'text',
      providerRef: 'p',
      modelRef: 'm',
      modelVersion: '1',
      dimension: 1,
      distance: 'cosine',
      normalization: 'l2',
    }
    expect(
      validateEmbeddingChannel({
        ...channel,
        channelId: '',
        providerRef: '',
        modelRef: '',
        modelVersion: '',
        dimension: 1.5,
        distance: 'bad',
        normalization: 'bad',
      }),
    ).toHaveLength(7)
    expect(validateEmbeddingChannel({ ...channel, modality: 'bad' })).not.toHaveLength(0)
    expect(validateProviderExecutionIdentity(null)).toHaveLength(1)
    expect(
      validateProviderExecutionIdentity({
        sourceVersionId: '',
        providerRef: '',
        providerVersion: '',
        inputFingerprint: '',
        runId: '',
        generation: 0,
        attempt: 1,
        modelRef: null,
        modelVersion: '',
      }),
    ).toHaveLength(7)
    expect(
      validateProviderExecutionIdentity({
        sourceVersionId: 'v',
        providerRef: 'p',
        providerVersion: '1',
        inputFingerprint: 'i',
        runId: 'r',
        generation: 0,
        attempt: 1,
        modelRef: null,
        modelVersion: null,
      }),
    ).toHaveLength(0)
    expect(
      validateProviderExecutionIdentity({
        sourceVersionId: 'v',
        providerRef: 'p',
        providerVersion: '1',
        inputFingerprint: 'i',
        runId: 'r',
        generation: 0,
        attempt: 1,
        modelRef: 'm',
        modelVersion: null,
      }),
    ).not.toHaveLength(0)
  })
})
