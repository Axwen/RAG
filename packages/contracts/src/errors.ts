/**
 * 统一 API 错误信封（devex 评审 DX-T3，并入 T1a）。
 *
 * 在 T1a 首个业务端点前立约定，避免后续 18 张票据出现五种错误风格。
 * 信封固定五字段：code（稳定错误码）、message（人读消息）、param（可选，出错的
 * 请求参数或路径）、doc_url（指向修复指引的文档锚点）、trace_id（关联本次请求的
 * 日志与审计）。未知错误不得泄露堆栈或供应商原文，统一映射 INTERNAL_ERROR。
 */

/** 稳定错误码。新增码只允许追加，不允许改义或复用。 */
export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'METHOD_NOT_ALLOWED'
  | 'CONFLICT'
  | 'PAYLOAD_TOO_LARGE'
  | 'UNSUPPORTED_MEDIA_TYPE'
  | 'COMPATIBILITY_VIOLATION'
  | 'DEPENDENCY_UNAVAILABLE'
  | 'RATE_LIMITED'
  | 'INTERNAL_ERROR'

/**
 * HTTP 状态码与错误码的固定映射；过滤器按此回写状态行。
 *
 * 每个码占用一个状态码，映射是双射：反向查找由 {@link errorCodeForStatus} 从本表
 * 派生，不在过滤器里另写一份 switch——两处枚举必然漂移，鉴权类状态码就是这么漏掉的。
 */
export const ERROR_STATUS: Readonly<Record<ErrorCode, number>> = Object.freeze({
  VALIDATION_ERROR: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405,
  CONFLICT: 409,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  COMPATIBILITY_VIOLATION: 422,
  DEPENDENCY_UNAVAILABLE: 503,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
})

const CODE_BY_STATUS: ReadonlyMap<number, ErrorCode> = new Map(
  Object.entries(ERROR_STATUS).map(([code, status]) => [status, code as ErrorCode]),
)

/**
 * HTTP 状态码 -> 错误码的反向查找。无对应码时返回 undefined，由调用方决定兜底，
 * 不在这里替它猜。
 */
export function errorCodeForStatus(status: number): ErrorCode | undefined {
  return CODE_BY_STATUS.get(status)
}

/** 统一错误信封：恰好五个字段，响应体不再携带其他顶层键。 */
export interface ApiErrorEnvelope {
  readonly code: ErrorCode
  readonly message: string
  readonly param: string | null
  readonly doc_url: string
  readonly trace_id: string
}

/** 文档锚点约定：所有错误码的修复指引集中在 docs/engineering/error-codes.md。 */
export const ERROR_DOC_BASE = 'docs/engineering/error-codes.md' as const

export function errorDocUrl(code: ErrorCode): string {
  return `${ERROR_DOC_BASE}#${code.toLowerCase()}`
}

/** 构造信封。param 为 null 表示与具体参数无关；显式传 undefined 等同不传。 */
export function apiError(
  code: ErrorCode,
  message: string,
  options: { readonly param?: string | undefined; readonly traceId?: string | undefined } = {},
): ApiErrorEnvelope {
  return {
    code,
    message,
    param: options.param ?? null,
    doc_url: errorDocUrl(code),
    trace_id: options.traceId ?? '',
  }
}
