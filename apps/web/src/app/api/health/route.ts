import { NextResponse } from 'next/server'

/**
 * Web 最小健康入口。
 *
 * 只回答"前端进程是否活着"，并透传对上游 API 的探测结果。上游不可用时返回 503，
 * 不返回 200：T0 验收要求关闭任一中间件时错误明确，不得伪装为可用。
 */
export const dynamic = 'force-dynamic'

const API_BASE_URL = process.env.API_BASE_URL ?? 'http://localhost:3001'

export async function GET(): Promise<NextResponse> {
  const startedAt = Date.now()
  try {
    const upstream = await fetch(`${API_BASE_URL.replace(/\/+$/, '')}/health/live`, {
      signal: AbortSignal.timeout(2000),
      cache: 'no-store',
    })
    if (!upstream.ok) {
      return NextResponse.json(
        { status: 'down', service: 'web', api: `unexpected_status_${upstream.status}` },
        { status: 503 },
      )
    }
    return NextResponse.json({
      status: 'up',
      service: 'web',
      api: 'up',
      latencyMs: Date.now() - startedAt,
    })
  } catch (error) {
    const reason = error instanceof Error ? error.name : 'unknown_error'
    return NextResponse.json({ status: 'down', service: 'web', api: reason }, { status: 503 })
  }
}
