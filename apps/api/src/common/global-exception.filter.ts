import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException } from '@nestjs/common'
import { randomUUID } from 'node:crypto'
import { ZodError } from 'zod'
import {
  ERROR_STATUS,
  apiError,
  errorCodeForStatus,
  type ApiErrorEnvelope,
  type ErrorCode,
} from '@rag/contracts'
import { createLogger } from '@rag/observability'

/**
 * 全局异常过滤器（DX-T3）：所有错误响应统一为五字段信封。
 *
 * - ApiErrorException：直接使用其信封（已是规范形态）。
 * - ZodError：参数校验失败，映射为 VALIDATION_ERROR，param 取第一个出错路径。
 * - HttpException（非信封形态，如 404 路由 miss、guard 抛的 401/403）：按状态码
 *   归一到对应错误码。
 * - 带 4xx 数字 `status` 的库层错误（如 body-parser 的畸形 JSON）：同样归一，
 *   不能让"请求写错了"变成"服务端故障、请重试"。
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
    const statusCarried = envelopeOfStatusCarryingError(exception)
    if (statusCarried !== undefined) {
      return statusCarried
    }
    return apiError('INTERNAL_ERROR', '内部错误，请稍后重试')
  }
}

/**
 * 库层错误不是 HttpException，但按 http-errors 约定带数字 `status`/`statusCode`：
 * express body-parser 对畸形 JSON 抛的就是 `SyntaxError { status: 400, expose: true }`。
 * 这类错误落进 INTERNAL_ERROR 会让客户端把"请求写错了"当成"服务端故障"去重试。
 *
 * 只认 4xx：5xx 一律走 INTERNAL_ERROR，避免把内部依赖的状态码原样透给客户端。
 * 只有 `expose === true`（http-errors 用它标记"可安全展示给客户端"）时才回显原文，
 * 否则用通用消息，堆栈与细节仍只进日志。
 */
function envelopeOfStatusCarryingError(exception: unknown): ApiErrorEnvelope | undefined {
  if (typeof exception !== 'object' || exception === null) {
    return undefined
  }
  const raw = exception as {
    status?: unknown
    statusCode?: unknown
    expose?: unknown
    message?: unknown
  }
  const status =
    typeof raw.status === 'number'
      ? raw.status
      : typeof raw.statusCode === 'number'
        ? raw.statusCode
        : undefined
  if (status === undefined || status < 400 || status >= 500) {
    return undefined
  }
  const exposable = raw.expose === true && typeof raw.message === 'string' && raw.message.length > 0
  return apiError(codeForStatus(status), exposable ? (raw.message as string) : '请求无法处理')
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

/**
 * 状态码 -> 错误码。映射表是 `ERROR_STATUS` 的反向派生（契约单一事实源），本函数
 * 只负责兜底口径：
 *
 * - 未列入映射的 4xx 归 VALIDATION_ERROR，而不是 INTERNAL_ERROR。客户端拿到的信号
 *   必须是"请求有问题"而不是"服务端挂了、请重试"；出现新的 4xx 语义时在
 *   `packages/contracts/src/errors.ts` 追加错误码，不要长期依赖这条兜底。
 * - 其余（含 5xx 与非法值）归 INTERNAL_ERROR。
 */
function codeForStatus(status: number): ErrorCode {
  const mapped = errorCodeForStatus(status)
  if (mapped !== undefined) {
    return mapped
  }
  return status >= 400 && status < 500 ? 'VALIDATION_ERROR' : 'INTERNAL_ERROR'
}
