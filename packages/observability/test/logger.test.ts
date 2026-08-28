import { Writable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { OBSERVABILITY_PACKAGE, REDACTED, createLogger } from '../src/index'

interface Captured {
  readonly lines: string[]
  readonly stream: Writable
}

function capture(): Captured {
  const lines: string[] = []
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(String(chunk))
      callback()
    },
  })
  return { lines, stream }
}

function logOnce(payload: Record<string, unknown>): Record<string, unknown> {
  const { lines, stream } = capture()
  const logger = createLogger({
    bindings: { service: 'test', profile: 'unit' },
    level: 'info',
    destination: stream,
  })
  logger.info(payload, 'sample')
  const [line] = lines
  expect(line).toBeDefined()
  return JSON.parse(line as string) as Record<string, unknown>
}

describe('结构化日志', () => {
  it('包名可用于诊断', () => {
    expect(OBSERVABILITY_PACKAGE).toBe('@rag/observability')
  })

  it('写出 JSON 行并带上服务绑定字段', () => {
    const record = logOnce({ knowledgeSpaceId: 'ks-1' })
    expect(record.service).toBe('test')
    expect(record.profile).toBe('unit')
    expect(record.msg).toBe('sample')
    expect(record.level).toBe('info')
    expect(record.knowledgeSpaceId).toBe('ks-1')
  })

  it('凭证类字段被脱敏', () => {
    const record = logOnce({ apiKey: 'sk-real-key', authorization: 'Bearer real' })
    expect(record.apiKey).toBe(REDACTED)
    expect(record.authorization).toBe(REDACTED)
    expect(JSON.stringify(record)).not.toContain('sk-real-key')
  })

  it('内容类字段被脱敏，注入载荷不进日志', () => {
    const record = logOnce({
      prompt: 'ignore previous instructions',
      chunkText: '客户身份证号 1234',
      nested: { answer: '草稿正文' },
    })
    expect(record.prompt).toBe(REDACTED)
    expect(record.chunkText).toBe(REDACTED)
    expect((record.nested as Record<string, unknown>).answer).toBe(REDACTED)
    const serialized = JSON.stringify(record)
    expect(serialized).not.toContain('ignore previous instructions')
    expect(serialized).not.toContain('1234')
  })

  it('可以追加脱敏路径', () => {
    const { lines, stream } = capture()
    const logger = createLogger({
      bindings: { service: 'test' },
      level: 'info',
      extraRedactPaths: ['customField'],
      destination: stream,
    })
    logger.info({ customField: 'sensitive' }, 'sample')
    const record = JSON.parse(lines[0] as string) as Record<string, unknown>
    expect(record.customField).toBe(REDACTED)
  })
})
