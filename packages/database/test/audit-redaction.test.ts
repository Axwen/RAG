import { describe, expect, it } from 'vitest'
import { REDACTED } from '@rag/observability'
import { Prisma } from '../src/generated/prisma/client'
import { redactAuditDetail } from '../src/audit/redact-detail'

/**
 * 审计 detail 脱敏（ADR-0040 / T11a）。
 *
 * 这一层的价值不是「脱敏函数能跑」，而是**审计行永远不会成为正文的第二个副本**：
 * 审计行不可变、不随业务数据删除而删除，所以一次漏脱敏就是一条永久留在库里的正文。
 * 字段名表复用 `@rag/observability`（只复用两张表，不 import 遥测导出器）。
 */

describe('redactAuditDetail', () => {
  it('把机密字段名替换成 REDACTED，键本身保留', () => {
    const output = redactAuditDetail({
      password: 'hunter2',
      apiKey: 'sk-live-1',
      pool: 'INTERACTIVE',
    })

    expect(output).toEqual({ password: REDACTED, apiKey: REDACTED, pool: 'INTERACTIVE' })
    // 键保留是刻意的：删掉键会让审计读侧看不出「这里原本有个凭据字段」。
    expect(Object.keys(output)).toContain('password')
  })

  it('把正文字段名替换成 REDACTED', () => {
    expect(redactAuditDetail({ text: '合同正文', snippet: '片段', chunkCount: 3 })).toEqual({
      text: REDACTED,
      snippet: REDACTED,
      chunkCount: 3,
    })
  })

  it('字段名比对忽略大小写与 _/- 分隔', () => {
    // 审计 detail 的键来自各个域的判定现场，snake_case 与 SCREAMING_CASE 都会出现。
    expect(
      redactAuditDetail({ Password: 'x', API_KEY: 'y', 'set-cookie': 'z', id_token: 'w' }),
    ).toEqual({
      Password: REDACTED,
      API_KEY: REDACTED,
      'set-cookie': REDACTED,
      id_token: REDACTED,
    })
  })

  it('递归进嵌套对象与数组', () => {
    const output = redactAuditDetail({
      request: { headers: { authorization: 'Bearer x' }, pool: 'EVALUATION' },
      candidates: [{ content: '正文一' }, { content: '正文二' }],
    })

    expect(output).toEqual({
      request: { headers: { authorization: REDACTED }, pool: 'EVALUATION' },
      candidates: [{ content: REDACTED }, { content: REDACTED }],
    })
  })

  it('带 toJSON 的对象按其 JSON 形式取值，不递归进内部字段', () => {
    // Prisma.Decimal 的内部表示是 s/e/d 三个字段。递归进去会写出一堆看不出金额的数字数组。
    const output = redactAuditDetail({
      delta: new Prisma.Decimal('-0.004200'),
      occurredAt: new Date('2026-09-03T12:00:00.000Z'),
    })

    expect(output).toEqual({ delta: '-0.0042', occurredAt: '2026-09-03T12:00:00.000Z' })
  })

  it('bigint 转成字符串（JSON 里没有 bigint）', () => {
    expect(redactAuditDetail({ tokens: 12345678901234567890n })).toEqual({
      tokens: '12345678901234567890',
    })
  })

  it('对象里丢掉 undefined/function/symbol 键', () => {
    const output = redactAuditDetail({
      kept: 1,
      missing: undefined,
      fn: () => 1,
      sym: Symbol('s'),
    })

    expect(output).toEqual({ kept: 1 })
  })

  it('数组里把同样的值归一成 null 而不是删掉', () => {
    // 删掉会让下标平移：审计里写「第 3 个候选被拦下」，读的时候指到的就是别的东西。
    const output = redactAuditDetail({ candidates: [1, undefined, 3] }) as {
      candidates: unknown[]
    }

    expect(output.candidates).toEqual([1, null, 3])
    expect(output.candidates).toHaveLength(3)
  })

  it('循环引用直接抛，不写一半进库', () => {
    const detail: Record<string, unknown> = { pool: 'INTERACTIVE' }
    detail.self = detail

    expect(() => redactAuditDetail(detail)).toThrow('循环引用')
  })

  it('同一个对象出现在两个位置不算循环', () => {
    const shared = { pool: 'INTERACTIVE' }

    expect(redactAuditDetail({ a: shared, b: shared })).toEqual({
      a: { pool: 'INTERACTIVE' },
      b: { pool: 'INTERACTIVE' },
    })
  })

  it('嵌套超过 8 层直接抛', () => {
    let deep: Record<string, unknown> = { leaf: true }
    for (let level = 0; level < 9; level += 1) {
      deep = { nested: deep }
    }

    expect(() => redactAuditDetail(deep)).toThrow('嵌套超过 8 层')
  })

  it('顶层原样返回一个新对象，不改入参', () => {
    const detail = { password: 'hunter2', pool: 'INTERACTIVE' }
    const output = redactAuditDetail(detail)

    expect(detail.password).toBe('hunter2')
    expect(output).not.toBe(detail)
  })
})
