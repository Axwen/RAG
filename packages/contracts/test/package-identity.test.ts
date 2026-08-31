import { describe, expect, it } from 'vitest'
import { CONTRACTS_PACKAGE, CONTRACTS_SCHEMA_VERSION } from '../src/index'

describe('@rag/contracts', () => {
  it('导出稳定的包标识', () => {
    expect(CONTRACTS_PACKAGE).toBe('@rag/contracts')
  })

  it('T1a 起 Manifest 契约 schema 版本为 1', () => {
    expect(CONTRACTS_SCHEMA_VERSION).toBe(1)
  })
})
