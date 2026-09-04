import { describe, expect, it } from 'vitest'
import { REDACTED } from '@rag/observability'
import { writeAuditEvent } from '../src/audit/write-audit-event'
import { createFakeTx } from './fake-tx'

/**
 * 审计写入口（T11a [写入口契约] / ADR-0040）。
 *
 * 这一层钉住的是**入口是唯一入口**这件事的前提：category 由注册表派生而不是调用方传、
 * reasonCode 必须已注册、actor 形状映射到两列、detail 过脱敏、traceId 只接受严格形状。
 * 「审计写失败即业务写失败」由入口抛异常 + 调用方在同一个 `tx` 上写来保证，回滚本身是集成层
 * （真实事务）才能证明的事。
 */

const tenantId = '018f0000-0000-7000-8000-000000000001'

describe('writeAuditEvent', () => {
  it('category 由 reasonCode 从注册表派生，调用方不传', () => {
    const { tx, audits } = createFakeTx()

    return writeAuditEvent(tx, {
      tenantId,
      reasonCode: 'budget.reserve_rejected',
      outcome: 'DENIED',
    }).then((result) => {
      expect(result.auditEventId).toBe('audit-1')
      expect(audits).toHaveLength(1)
      expect(audits[0]?.category).toBe('BUDGET')
      expect(audits[0]?.reasonCode).toBe('budget.reserve_rejected')
      expect(audits[0]?.outcome).toBe('DENIED')
    })
  })

  it('未注册的 reasonCode 直接抛', async () => {
    const { tx, audits } = createFakeTx()

    await expect(
      writeAuditEvent(tx, {
        // 绕过 TS 才可能发生（JS 调用方、反序列化的入参）；库里还有一条格式 CHECK 兜底。
        reasonCode: 'budget.made_up' as never,
        tenantId,
        outcome: 'DENIED',
      }),
    ).rejects.toThrow('reasonCode 未注册')
    expect(audits).toHaveLength(0)
  })

  it('空 tenantId 直接抛', async () => {
    const { tx } = createFakeTx()

    await expect(
      writeAuditEvent(tx, {
        tenantId: '',
        reasonCode: 'budget.lease_expired',
        outcome: 'RECLAIMED',
      }),
    ).rejects.toThrow('tenantId 为空')
  })

  it('不传 actor 记 SYSTEM + actorId 空', async () => {
    const { tx, audits } = createFakeTx()

    await writeAuditEvent(tx, {
      tenantId,
      reasonCode: 'budget.lease_expired',
      outcome: 'RECLAIMED',
    })

    expect(audits[0]?.actorType).toBe('SYSTEM')
    expect(audits[0]?.actorId).toBeNull()
  })

  it('业务用户记 BUSINESS_USER + uuid', async () => {
    const { tx, audits } = createFakeTx()

    await writeAuditEvent(tx, {
      tenantId,
      reasonCode: 'budget.reserve_rejected',
      outcome: 'DENIED',
      actor: { businessUserId: '018f0000-0000-7000-8000-0000000000aa' },
    })

    expect(audits[0]?.actorType).toBe('BUSINESS_USER')
    expect(audits[0]?.actorId).toBe('018f0000-0000-7000-8000-0000000000aa')
  })

  it('系统动作记 SYSTEM + 动作名（不是 uuid）', async () => {
    const { tx, audits } = createFakeTx()

    await writeAuditEvent(tx, {
      tenantId,
      reasonCode: 'budget.lease_expired',
      outcome: 'RECLAIMED',
      actor: { system: 'LEASE_REAPER' },
    })

    expect(audits[0]?.actorType).toBe('SYSTEM')
    // 这就是 actorId 不能是 @db.Uuid 的原因。
    expect(audits[0]?.actorId).toBe('LEASE_REAPER')
  })

  it('BUSINESS_USER 的 actorId 为空直接抛', async () => {
    const { tx } = createFakeTx()

    await expect(
      writeAuditEvent(tx, {
        tenantId,
        reasonCode: 'budget.reserve_rejected',
        outcome: 'DENIED',
        actor: { businessUserId: '' },
      }),
    ).rejects.toThrow('businessUserId 为空')
  })

  it('subject 成对写入，不传则两列都空', async () => {
    const { tx, audits } = createFakeTx()

    await writeAuditEvent(tx, {
      tenantId,
      reasonCode: 'budget.settlement_delta',
      outcome: 'ALLOWED',
      subject: { type: 'model_budget_ledger', id: 'row-1' },
    })
    await writeAuditEvent(tx, {
      tenantId,
      reasonCode: 'budget.settlement_delta',
      outcome: 'ALLOWED',
    })

    expect(audits[0]?.subjectType).toBe('model_budget_ledger')
    expect(audits[0]?.subjectId).toBe('row-1')
    expect(audits[1]?.subjectType).toBeNull()
    expect(audits[1]?.subjectId).toBeNull()
  })

  it('detail 在写库前过脱敏', async () => {
    const { tx, audits } = createFakeTx()

    await writeAuditEvent(tx, {
      tenantId,
      reasonCode: 'budget.reserve_rejected',
      outcome: 'DENIED',
      detail: { layer: 'DAILY', prompt: '用户原始问题', apiKey: 'sk-live-1' },
    })

    expect(audits[0]?.detail).toEqual({ layer: 'DAILY', prompt: REDACTED, apiKey: REDACTED })
  })

  it('不传 detail 时不写这一列（exactOptionalPropertyTypes 下 undefined 不等于省略）', async () => {
    const { tx, audits } = createFakeTx()

    await writeAuditEvent(tx, {
      tenantId,
      reasonCode: 'budget.pool_boundary_rejected',
      outcome: 'DENIED',
    })

    expect(audits[0] && 'detail' in audits[0]).toBe(false)
  })

  it('接受 32 位十六进制 trace-id 与服务端 UUID 两种形状', async () => {
    const { tx, audits } = createFakeTx()

    await writeAuditEvent(tx, {
      tenantId,
      reasonCode: 'budget.lease_expired',
      outcome: 'RECLAIMED',
      traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
    })
    await writeAuditEvent(tx, {
      tenantId,
      reasonCode: 'budget.lease_expired',
      outcome: 'RECLAIMED',
      traceId: '0198f7c4-1c2a-7b3d-8e4f-5a6b7c8d9e0f',
    })

    expect(audits[0]?.traceId).toBe('4bf92f3577b34da6a3ce929d0e0e4736')
    expect(audits[1]?.traceId).toBe('0198f7c4-1c2a-7b3d-8e4f-5a6b7c8d9e0f')
  })

  it('形状非法的 traceId 直接抛，不回落成 null', async () => {
    const { tx } = createFakeTx()

    // 回落成 null 会让「客户端塞了任意头」和「这次调用没有 trace」在库里长得一样。
    for (const traceId of ['not-a-trace', '4BF92F3577B34DA6A3CE929D0E0E4736', '', '00000000']) {
      await expect(
        writeAuditEvent(tx, {
          tenantId,
          reasonCode: 'budget.lease_expired',
          outcome: 'RECLAIMED',
          traceId,
        }),
      ).rejects.toThrow('traceId 形状非法')
    }
  })

  it('不传 traceId 也要写成功：审计不依赖遥测', async () => {
    const { tx, audits } = createFakeTx()

    await writeAuditEvent(tx, {
      tenantId,
      reasonCode: 'budget.settlement_delta',
      outcome: 'ALLOWED',
    })

    expect(audits[0]?.traceId).toBeNull()
  })

  it('occurredAt 用事务时钟，同一事务里的多条审计取到同一个时刻', async () => {
    const now = new Date('2026-09-03T12:00:00.000Z')
    const { tx, audits } = createFakeTx({ now })

    await writeAuditEvent(tx, {
      tenantId,
      reasonCode: 'budget.reserve_rejected',
      outcome: 'DENIED',
    })
    await writeAuditEvent(tx, {
      tenantId,
      reasonCode: 'budget.settlement_delta',
      outcome: 'ALLOWED',
    })

    // 省略这一列会让 Prisma 在客户端逐条生成时间（假事务把这种情况填成 now + 5s），
    // 于是同一个事务里的两条审计差几毫秒、且与业务行不是同一个时刻——审计顺序就成了
    // 应用时钟的函数。列的 DEFAULT 只兜住原始 SQL 写入者。
    expect(audits.map((row) => row.occurredAt.toISOString())).toEqual([
      '2026-09-03T12:00:00.000Z',
      '2026-09-03T12:00:00.000Z',
    ])
  })
})
