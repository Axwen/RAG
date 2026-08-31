import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common'
import { randomUUID } from 'node:crypto'
import { ZodError } from 'zod'
import { ERROR_STATUS, apiError, type ApiErrorEnvelope, type ErrorCode } from '@rag/contracts'
import { createLogger } from '@rag/observability'

/**
 * 全局异常过滤器（DX-T3）：所有错误响应统一为五字段信封。
 *
 * - ApiErrorException：直接使用其信封（已是规范形态）。
 * - ZodError：参数校验失败，映射为 VALIDATION_ERROR，param 取第一个出错路径。
 * - HttpException（非信封形态，如 404 路由 miss）：按状态码归一到最近错误码。
 * - 其他异常：INTERNAL_ERROR，不向外泄露堆栈或供应商原文，详情进日志。
 *
 * 每封响应都带 trace_id：INTERNAL_ERROR 的细节只进日志，用户手里必须有一个
 * 能反查那条日志的标识。
 */
@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = createLogger({ bindings: { service: 'api' } })

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp()
    const response = ctx.getResponse<{
      status(code: number): { json(body: unknown): unknown }
    }>()
    const request = ctx.getRequest<{
      method?: string
      url?: string
      headers?: Record<string, string | string[] | undefined>
    }>()

    const base = this.toEnvelope(exception)
    const traceId = base.trace_id.length > 0 ? base.trace_id : resolveTraceId(request.headers)
    const envelope: ApiErrorEnvelope = { ...base, trace_id: traceId }
    const status = ERROR_STATUS[envelope.code]
    if (envelope.code === 'INTERNAL_ERROR') {
      this.logger.error(
        {
          err: exception instanceof Error ? exception.stack : String(exception),
          method: request.method,
          url: request.url,
          traceId,
        },
        'unhandled exception',
      )
    }
    response.status(status).json(envelope)
  }

  private toEnvelope(exception: unknown): ApiErrorEnvelope {
    if (exception instanceof HttpException && 'envelope' in exception) {
      return (exception as { envelope: ApiErrorEnvelope }).envelope
    }
    if (exception instanceof ZodError) {
      const first = exception.issues[0]
      return apiError('VALIDATION_ERROR', first?.message ?? '请求参数不合法', {
        param: first?.path.join('.'),
      })
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus()
      const code = codeForStatus(status)
      const body = exception.getResponse()
      const message =
        typeof body === 'string'
          ? body
          : (((body as { message?: unknown }).message as string | undefined) ?? exception.message)
      return apiError(code, Array.isArray(message) ? message.join('; ') : message)
    }
    return apiError('INTERNAL_ERROR', '内部错误，请稍后重试')
  }
}

/**
 * 取本次请求的 trace 标识：优先复用 W3C `traceparent` 的 trace-id（严格校验
 * 32 位小写十六进制），否则服务端生成。不接受其他客户端自定义头，避免把任意
 * 客户端输入回显进响应体。
 */
function resolveTraceId(headers: Record<string, string | string[] | undefined> = {}): string {
  const raw = headers['traceparent']
  const traceparent = Array.isArray(raw) ? raw[0] : raw
  const traceId = traceparent?.split('-')[1]
  if (traceId !== undefined && /^[0-9a-f]{32}$/.test(traceId)) {
    return traceId
  }
  return randomUUID()
}

function codeForStatus(status: number): ErrorCode {
  switch (status) {
    case HttpStatus.BAD_REQUEST:
      return 'VALIDATION_ERROR'
    case HttpStatus.NOT_FOUND:
      return 'NOT_FOUND'
    case HttpStatus.CONFLICT:
      return 'CONFLICT'
    case HttpStatus.UNPROCESSABLE_ENTITY:
      return 'COMPATIBILITY_VIOLATION'
    case HttpStatus.TOO_MANY_REQUESTS:
      return 'RATE_LIMITED'
    case HttpStatus.SERVICE_UNAVAILABLE:
      return 'DEPENDENCY_UNAVAILABLE'
    default:
      return 'INTERNAL_ERROR'
  }
}
