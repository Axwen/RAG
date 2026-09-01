import { Writable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { createLogger } from '@rag/observability'
import {
  ForbiddenException,
  HttpException,
  HttpStatus,
  UnauthorizedException,
} from '@nestjs/common'
import type { ArgumentsHost } from '@nestjs/common'
import { z } from 'zod'
import { GlobalExceptionFilter } from '../src/common/global-exception.filter'
import { ApiErrorException } from '../src/common/api-error.exception'

function mockHost(
  request: { method?: string; url?: string; headers?: Record<string, string> } = {},
) {
  const status = vi.fn()
  const json = vi.fn()
  status.mockReturnValue({ json })
  const host = {
    switchToHttp: () => ({
      getResponse: () => ({ status, json }),
      getRequest: () => request,
    }),
  }
  return { host: host as unknown as ArgumentsHost, status, json }
}

/** 取过滤器写出的唯一一封响应体。 */
function sentEnvelope(json: ReturnType<typeof vi.fn>): Record<string, unknown> {
  expect(json).toHaveBeenCalledTimes(1)
  const call = json.mock.calls[0]
  if (call === undefined) {
    throw new Error('过滤器未写出响应体')
  }
  return call[0] as Record<string, unknown>
}

/** 把过滤器的日志接到内存流，用来验证响应体的 trace_id 确实能反查日志。 */
function filterWithLogSink(): {
  filter: GlobalExceptionFilter
  lines: Record<string, unknown>[]
} {
  const lines: Record<string, unknown>[] = []
  const stream = new Writable({
    write(chunk, _enc, cb) {
      for (const raw of String(chunk).split('\n')) {
        if (raw.trim() !== '') lines.push(JSON.parse(raw) as Record<string, unknown>)
      }
      cb()
    },
  })
  const logger = createLogger({ bindings: { service: 'api' }, destination: stream })
  return { filter: new GlobalExceptionFilter(logger), lines }
}

describe('全局异常过滤器（DX-T3 错误信封）', () => {
  // 走内存 sink，避免 INTERNAL_ERROR 用例把堆栈打进测试输出
  const { filter } = filterWithLogSink()

  it('领域异常直接回写五字段信封与映射状态码', () => {
    const { host, status, json } = mockHost()
    filter.catch(
      new ApiErrorException('NOT_FOUND', 'IngestionManifest 不存在', { param: 'id' }),
      host,
    )
    expect(status).toHaveBeenCalledWith(404)
    const envelope = sentEnvelope(json)
    expect(Object.keys(envelope).sort()).toEqual([
      'code',
      'doc_url',
      'message',
      'param',
      'trace_id',
    ])
    expect(envelope.code).toBe('NOT_FOUND')
    expect(envelope.param).toBe('id')
    expect(String(envelope.doc_url)).toMatch(/#not_found$/)
  })

  it('Zod 校验失败映射为 VALIDATION_ERROR，param 取出错路径', () => {
    const { host, status, json } = mockHost()
    // 用真实 schema 产生 ZodError，避免手拼 issue 类型
    const schema = z.object({ candidateBudget: z.literal(1024) })
    const result = schema.safeParse({ candidateBudget: 2048 })
    if (result.success) {
      throw new Error('safeParse 不应成功')
    }
    filter.catch(result.error, host)
    expect(status).toHaveBeenCalledWith(400)
    const envelope = sentEnvelope(json)
    expect(envelope.code).toBe('VALIDATION_ERROR')
    expect(envelope.param).toBe('candidateBudget')
  })

  it('普通 HttpException 按状态码归一到错误码', () => {
    const { host, status, json } = mockHost()
    filter.catch(new HttpException('路由不存在', HttpStatus.NOT_FOUND), host)
    expect(status).toHaveBeenCalledWith(404)
    expect(sentEnvelope(json).code).toBe('NOT_FOUND')
  })

  // T14 的 guard 抛的就是这两个异常。它们若归到 INTERNAL_ERROR/500，客户端拿到的
  // 信号是"服务端故障、请重试"而不是"重新登录"，并且每次鉴权拒绝都会带堆栈写进
  // 错误日志、当成未处理异常。
  it('鉴权异常保留 401/403，不落到 INTERNAL_ERROR', () => {
    const unauthorized = mockHost()
    filter.catch(new UnauthorizedException('token 已过期'), unauthorized.host)
    expect(unauthorized.status).toHaveBeenCalledWith(401)
    expect(sentEnvelope(unauthorized.json).code).toBe('UNAUTHORIZED')

    const forbidden = mockHost()
    filter.catch(new ForbiddenException('无该 Workspace 的能力权限'), forbidden.host)
    expect(forbidden.status).toHaveBeenCalledWith(403)
    expect(sentEnvelope(forbidden.json).code).toBe('FORBIDDEN')
  })

  it('带 4xx 数字 status 的库层错误按该状态码归一（body-parser 畸形 JSON）', () => {
    const { host, status, json } = mockHost({ method: 'POST', url: '/manifests/ingestion' })
    // express body-parser 抛的形状：SyntaxError + status 400 + expose:true
    const malformed = Object.assign(new SyntaxError('Unexpected token } in JSON at position 5'), {
      status: 400,
      expose: true,
    })
    filter.catch(malformed, host)
    expect(status).toHaveBeenCalledWith(400)
    expect(sentEnvelope(json).code).toBe('VALIDATION_ERROR')
  })

  it('带 5xx status 或 expose 非 true 的库层错误不外泄原文', () => {
    const upstream = mockHost()
    filter.catch(
      Object.assign(new Error('vendor said: quota exhausted'), { status: 502 }),
      upstream.host,
    )
    expect(upstream.status).toHaveBeenCalledWith(500)
    const upstreamEnvelope = sentEnvelope(upstream.json)
    expect(upstreamEnvelope.code).toBe('INTERNAL_ERROR')
    expect(JSON.stringify(upstreamEnvelope)).not.toContain('quota exhausted')

    const hidden = mockHost()
    filter.catch(Object.assign(new Error('internal-secret'), { status: 409 }), hidden.host)
    expect(hidden.status).toHaveBeenCalledWith(409)
    const hiddenEnvelope = sentEnvelope(hidden.json)
    expect(hiddenEnvelope.code).toBe('CONFLICT')
    expect(JSON.stringify(hiddenEnvelope)).not.toContain('internal-secret')
  })

  it('未列入映射的 4xx 归 VALIDATION_ERROR，不冒充服务端故障', () => {
    const { host, status, json } = mockHost()
    filter.catch(new HttpException('teapot', 418), host)
    expect(status).toHaveBeenCalledWith(400)
    expect(sentEnvelope(json).code).toBe('VALIDATION_ERROR')
  })

  it('未知异常映射 INTERNAL_ERROR，不泄露堆栈与原始消息', () => {
    const { host, status, json } = mockHost({ method: 'GET', url: '/releases/1' })
    const leaky = new Error('secret-internal-detail')
    filter.catch(leaky, host)
    expect(status).toHaveBeenCalledWith(500)
    const envelope = sentEnvelope(json)
    expect(envelope.code).toBe('INTERNAL_ERROR')
    expect(envelope.message).not.toContain('secret-internal-detail')
    expect(JSON.stringify(envelope)).not.toContain('stack')
    // 细节只进日志，用户手里必须留下能反查那条日志的标识
    expect(String(envelope.trace_id)).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('trace_id 复用 W3C traceparent 的 trace-id，非法格式时改用服务端生成', () => {
    const traceId = '4bf92f3577b34da6a3ce929d0e0e4736'
    const { host, json } = mockHost({
      headers: { traceparent: `00-${traceId}-00f067aa0ba902b7-01` },
    })
    filter.catch(new Error('boom'), host)
    expect(sentEnvelope(json).trace_id).toBe(traceId)

    const bogus = mockHost({ headers: { traceparent: '00-not-a-trace-id-01' } })
    filter.catch(new Error('boom'), bogus.host)
    expect(String(sentEnvelope(bogus.json).trace_id)).toMatch(/^[0-9a-f-]{36}$/)
  })
})

describe('INTERNAL_ERROR 的日志可反查性', () => {
  it('响应体的 trace_id 与日志行的 traceId 是同一个，且堆栈只在日志里', () => {
    const { filter, lines } = filterWithLogSink()
    const { host, status, json } = mockHost({
      method: 'POST',
      url: '/manifests/ingestion',
      headers: { traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01' },
    })

    filter.catch(new Error('数据库连接串 postgresql://u:p@h/db 泄漏风险'), host)

    expect(status).toHaveBeenCalledWith(500)
    const envelope = sentEnvelope(json)
    expect(envelope.code).toBe('INTERNAL_ERROR')
    // 响应体里没有原始错误信息，只有一个可反查的标识
    expect(String(envelope.message)).not.toContain('postgresql://')
    expect(envelope.trace_id).toBe('4bf92f3577b34da6a3ce929d0e0e4736')

    expect(lines).toHaveLength(1)
    const line = lines[0] as { traceId?: string; err?: string; method?: string; url?: string }
    expect(line.traceId).toBe(envelope.trace_id)
    expect(String(line.err)).toContain('数据库连接串')
    expect(line.method).toBe('POST')
    expect(line.url).toBe('/manifests/ingestion')
  })

  it('4xx 不写错误日志——鉴权拒绝与参数错误不该污染错误日志', () => {
    const { filter, lines } = filterWithLogSink()
    filter.catch(new UnauthorizedException('token 过期'), mockHost().host)
    filter.catch(new ApiErrorException('NOT_FOUND', '不存在'), mockHost().host)

    expect(lines).toHaveLength(0)
  })
})
