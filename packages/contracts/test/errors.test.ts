import { describe, expect, it } from 'vitest'
import {
  ERROR_DOC_BASE,
  ERROR_STATUS,
  apiError,
  errorCodeForStatus,
  type ErrorCode,
} from '../src/errors'

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

  it('鉴权与上传类状态码都有对应错误码：guard 抛的 401/403 不得变成 500', () => {
    expect(errorCodeForStatus(401)).toBe('UNAUTHORIZED')
    expect(errorCodeForStatus(403)).toBe('FORBIDDEN')
    expect(errorCodeForStatus(405)).toBe('METHOD_NOT_ALLOWED')
    expect(errorCodeForStatus(413)).toBe('PAYLOAD_TOO_LARGE')
    expect(errorCodeForStatus(415)).toBe('UNSUPPORTED_MEDIA_TYPE')
  })

  it('状态码映射是双射：每个码都能由其状态码反查回来', () => {
    const codes = Object.keys(ERROR_STATUS) as readonly ErrorCode[]
    const statuses = codes.map((code) => ERROR_STATUS[code])
    // 一码一状态：出现重复状态码时反向查找就不再确定，过滤器会把两个语义混为一个
    expect(new Set(statuses).size).toBe(codes.length)
    for (const code of codes) {
      expect(errorCodeForStatus(ERROR_STATUS[code])).toBe(code)
    }
  })

  it('未映射的状态码返回 undefined，由调用方决定兜底', () => {
    expect(errorCodeForStatus(418)).toBeUndefined()
    expect(errorCodeForStatus(200)).toBeUndefined()
  })
})
