import { describe, expect, it } from 'vitest'
import {
  EMBEDDING_DIMENSIONS,
  FROZEN_CHUNKING_MANIFEST_ID,
  RAG_CORE_PACKAGE,
  RERANK_OUTPUT_TOP_K,
  SUPPORTED_CONTRACTS_SCHEMA_VERSION,
} from '../src/index'

describe('冻结常量', () => {
  it('包名可用于诊断', () => {
    expect(RAG_CORE_PACKAGE).toBe('@rag/rag-core')
  })

  it('分块清单标识为 PROBE-006 定档值', () => {
    expect(FROZEN_CHUNKING_MANIFEST_ID).toBe('wide-1024')
  })

  it('Embedding 维度为 1024', () => {
    expect(EMBEDDING_DIMENSIONS).toBe(1024)
  })

  it('Rerank 输出上限为 5', () => {
    expect(RERANK_OUTPUT_TOP_K).toBe(5)
  })

  it('契约 schema 版本对齐 @rag/contracts', () => {
    expect(SUPPORTED_CONTRACTS_SCHEMA_VERSION).toBe(1)
  })
})
