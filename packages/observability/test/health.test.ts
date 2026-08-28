import { createServer, type Server } from 'node:http'
import { createServer as createTcpServer, type Server as TcpServer } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { aggregateHealth, probeHttp, probeRedis, probeTcp } from '../src/health'

const closers: Array<() => Promise<void>> = []

afterEach(async () => {
  while (closers.length > 0) {
    const close = closers.pop()
    if (close) await close()
  }
})

async function httpServerOn(status: number): Promise<number> {
  const server: Server = createServer((_req, res) => {
    res.statusCode = status
    res.end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  return address.port
}

async function tcpServer(onData?: (data: Buffer) => string): Promise<number> {
  const server: TcpServer = createTcpServer((socket) => {
    socket.on('data', (data: Buffer) => {
      if (onData) socket.write(onData(data))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  return address.port
}

describe('HTTP 探测', () => {
  it('2xx 视为 up', async () => {
    const port = await httpServerOn(200)
    const result = await probeHttp('svc', `http://127.0.0.1:${port}/`)
    expect(result.status).toBe('up')
    expect(result.reason).toBeUndefined()
  })

  it('非预期状态码视为 down 且给出原因', async () => {
    const port = await httpServerOn(503)
    const result = await probeHttp('svc', `http://127.0.0.1:${port}/`)
    expect(result.status).toBe('down')
    expect(result.reason).toBe('unexpected_status_503')
  })

  it('可自定义可接受状态码', async () => {
    const port = await httpServerOn(401)
    const result = await probeHttp('svc', `http://127.0.0.1:${port}/`, {
      acceptStatus: (status) => status === 401,
    })
    expect(result.status).toBe('up')
  })

  it('端口无人监听时明确 down，不伪装为可用', async () => {
    const result = await probeHttp('svc', 'http://127.0.0.1:1/', { timeoutMs: 500 })
    expect(result.status).toBe('down')
    expect(result.reason).toBeDefined()
  })
})

describe('TCP 与 Redis 探测', () => {
  it('可连接即 up', async () => {
    const port = await tcpServer()
    const result = await probeTcp('svc', '127.0.0.1', port, 500)
    expect(result.status).toBe('up')
  })

  it('Redis 回 +PONG 才算 up', async () => {
    const good = await tcpServer(() => '+PONG\r\n')
    const bad = await tcpServer(() => '-ERR\r\n')
    await expect(probeRedis('redis', '127.0.0.1', good, 500)).resolves.toMatchObject({
      status: 'up',
    })
    await expect(probeRedis('redis', '127.0.0.1', bad, 500)).resolves.toMatchObject({
      status: 'down',
      reason: 'unexpected_redis_reply',
    })
  })
})

describe('聚合', () => {
  it('任一依赖 down 则整体 down', () => {
    const report = aggregateHealth([
      { name: 'a', status: 'up', latencyMs: 1 },
      { name: 'b', status: 'down', latencyMs: 2, reason: 'ECONNREFUSED' },
    ])
    expect(report.status).toBe('down')
    expect(report.dependencies).toHaveLength(2)
    expect(Date.parse(report.checkedAt)).not.toBeNaN()
  })

  it('全部 up 则整体 up', () => {
    expect(aggregateHealth([{ name: 'a', status: 'up', latencyMs: 1 }]).status).toBe('up')
  })
})
