import { describe, expect, it } from 'vitest'
import {
  DOCUMENT_CHUNKING_MANIFEST_ID,
  FROZEN_CHUNKING_MANIFEST_ID,
  RAG_CORE_PACKAGE,
  RERANK_OUTPUT_TOP_K,
  SUPPORTED_CONTRACTS_SCHEMA_VERSION,
} from '../src/index'

describe('核心常量', () => {
  it('包名可用于诊断', () => {
    expect(RAG_CORE_PACKAGE).toBe('@rag/rag-core')
  })

  it('wide-1024 明确只属于文档分块', () => {
    expect(DOCUMENT_CHUNKING_MANIFEST_ID).toBe('wide-1024')
    expect(FROZEN_CHUNKING_MANIFEST_ID).toBe(DOCUMENT_CHUNKING_MANIFEST_ID)
  })

  it('Rerank 输出上限为 5', () => {
    expect(RERANK_OUTPUT_TOP_K).toBe(5)
  })

  it('契约 schema 版本对齐 @rag/contracts', () => {
    expect(SUPPORTED_CONTRACTS_SCHEMA_VERSION).toBe(1)
  })
})
