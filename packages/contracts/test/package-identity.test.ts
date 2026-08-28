import { describe, expect, it } from 'vitest'
import { CONTRACTS_PACKAGE, CONTRACTS_SCHEMA_VERSION } from '../src/index'

describe('@rag/contracts', () => {
  it('导出稳定的包标识', () => {
    expect(CONTRACTS_PACKAGE).toBe('@rag/contracts')
  })

  it('阶段 1 契约 schema 版本尚未发布', () => {
    expect(CONTRACTS_SCHEMA_VERSION).toBe(0)
  })
})
