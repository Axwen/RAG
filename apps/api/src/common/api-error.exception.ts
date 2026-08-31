import { HttpException } from '@nestjs/common'
import { type ApiErrorEnvelope, type ErrorCode, ERROR_STATUS, apiError } from '@rag/contracts'

/**
 * 携带统一错误信封的领域异常（DX-T3）。
 *
 * 业务代码只抛出稳定错误码 + 人读消息；HTTP 状态码由 ERROR_STATUS 映射，
 * 信封字段由全局过滤器统一回写，业务代码不手拼响应体。
 */
export class ApiErrorException extends HttpException {
  readonly envelope: ApiErrorEnvelope

  constructor(
    code: ErrorCode,
    message: string,
    options: { readonly param?: string; readonly traceId?: string } = {},
  ) {
    const envelope = apiError(code, message, options)
    super(envelope, ERROR_STATUS[code])
    this.envelope = envelope
  }
}
