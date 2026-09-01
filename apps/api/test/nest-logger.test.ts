import { Writable } from 'node:stream'
import { createLogger } from '@rag/observability'
import { describe, expect, it } from 'vitest'
import { NestPinoLogger } from '../src/common/nest-logger'

/** 收集 pino 写出的每一行并解析为 JSON。 */
function collect(): { lines: Record<string, unknown>[]; stream: Writable } {
  const lines: Record<string, unknown>[] = []
  const stream = new Writable({
    write(chunk, _enc, cb) {
      for (const raw of String(chunk).split('\n')) {
        if (raw.trim() !== '') lines.push(JSON.parse(raw) as Record<string, unknown>)
      }
      cb()
    },
  })
  return { lines, stream }
}

function subject(level = 'trace'): ReturnType<typeof collect> & { nest: NestPinoLogger } {
  const sink = collect()
  const logger = createLogger({
    bindings: { service: 'api' },
    level,
    destination: sink.stream,
  })
  return { ...sink, nest: new NestPinoLogger(logger) }
}

describe('NestPinoLogger', () => {
  it('把框架日志写成带 service 的结构化 JSON，而不是 ConsoleLogger 的纯文本', () => {
    const { lines, nest } = subject()
    nest.log('Nest application successfully started', 'NestApplication')

    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({
      level: 'info',
      service: 'api',
      nest: true,
      context: 'NestApplication',
      msg: 'Nest application successfully started',
    })
    expect(lines[0]?.time).toBeTypeOf('string')
  })

  it('映射 Nest 的六个级别到 pino 级别', () => {
    const { lines, nest } = subject()
    nest.verbose('v')
    nest.debug('d')
    nest.log('i')
    nest.warn('w')
    nest.error('e')
    nest.fatal('f')

    expect(lines.map((line) => line.level)).toEqual([
      'trace',
      'debug',
      'info',
      'warn',
      'error',
      'fatal',
    ])
  })

  it('Error 入参走 err 字段，保留栈但不做字符串拼接', () => {
    const { lines, nest } = subject()
    nest.error(new Error('boom'), 'ExceptionsHandler')

    expect(lines[0]?.msg).toBe('boom')
    expect(lines[0]?.context).toBe('ExceptionsHandler')
    const err = lines[0]?.err as { name: string; stack: string }
    expect(err.name).toBe('Error')
    expect(err.stack).toContain('boom')
  })

  it('框架日志同样受 redact 约束——这是接管 ConsoleLogger 的主要理由', () => {
    const { lines, nest } = subject()
    // Nest 的额外参数（如打印出的对象）此前直接进 stdout，绕过脱敏
    nest.error({ password: 'hunter2', authorization: 'Bearer real-token' }, 'RoutesResolver')
    // 附加参数同样是一条通路
    nest.log('query failed', { apiKey: 'sk-real' }, 'TypeOrmModule')

    const serialized = JSON.stringify(lines)
    expect(serialized).not.toContain('hunter2')
    expect(serialized).not.toContain('real-token')
    expect(serialized).not.toContain('sk-real')
    // 断言是"被脱敏"而不是"被丢掉"：字段仍在，值被替换
    expect(serialized).toContain('[REDACTED]')
  })

  it('无 context 时不产出空 context 字段', () => {
    const { lines, nest } = subject()
    nest.log('no context here')

    expect(lines[0]).not.toHaveProperty('context')
  })
})
