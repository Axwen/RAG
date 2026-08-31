import { describe, expect, it } from 'vitest'
import { ERROR_DOC_BASE, ERROR_STATUS, apiError } from '../src/errors'

describe('API 错误信封（DX-T3）', () => {
  it('固定五字段：code/message/param/doc_url/trace_id', () => {
    const envelope = apiError('VALIDATION_ERROR', 'candidateBudget 必须为正整数', {
      param: 'candidateBudget',
      traceId: 'trace-123',
    })
    expect(Object.keys(envelope).sort()).toEqual([
      'code',
      'doc_url',
      'message',
      'param',
      'trace_id',
    ])
    expect(envelope).toEqual({
      code: 'VALIDATION_ERROR',
      message: 'candidateBudget 必须为正整数',
      param: 'candidateBudget',
      doc_url: `${ERROR_DOC_BASE}#validation_error`,
      trace_id: 'trace-123',
    })
  })

  it('param 默认 null，表示与具体参数无关', () => {
    expect(apiError('INTERNAL_ERROR', '内部错误').param).toBeNull()
  })

  it('doc_url 锚点与错误码一一对应', () => {
    const envelope = apiError('COMPATIBILITY_VIOLATION', '组合不兼容')
    expect(envelope.doc_url).toBe(`${ERROR_DOC_BASE}#compatibility_violation`)
  })

  it('每个错误码都有确定的 HTTP 状态码', () => {
    expect(ERROR_STATUS.COMPATIBILITY_VIOLATION).toBe(422)
    expect(ERROR_STATUS.RATE_LIMITED).toBe(429)
    expect(ERROR_STATUS.INTERNAL_ERROR).toBe(500)
    expect(ERROR_STATUS.DEPENDENCY_UNAVAILABLE).toBe(503)
  })
})
