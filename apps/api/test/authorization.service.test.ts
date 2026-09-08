import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuthorizationRequest } from '@rag/contracts'
import {
  compileAllowedScopes,
  recheckCandidates,
  resolveCapabilities,
  writeAuditEvent,
} from '@rag/database'
import { AuthorizationService } from '../src/authorization/authorization.service'

/**
 * 统一授权入口的单元层（T14b）。
 *
 * 查库入口与审计写入口都是外部边界，在这里换成桩：这一层钉的是判定
 * 顺序（能力先于资源）、审计的 outcome/reasonCode 映射、以及两条
 * fail-closed 纪律——依赖不可用拒绝、允许路径审计写失败不放行。
 * 撤权后作用域收窄与真实审计行在集成层。
 */

vi.mock('@rag/database', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    compileAllowedScopes: vi.fn(),
    recheckCandidates: vi.fn(),
    resolveCapabilities: vi.fn(),
    writeAuditEvent: vi.fn(),
  }
})

const capabilitiesMock = vi.mocked(resolveCapabilities)
const scopesMock = vi.mocked(compileAllowedScopes)
const recheckMock = vi.mocked(recheckCandidates)
const auditMock = vi.mocked(writeAuditEvent)

function makeService(): {
  service: AuthorizationService
  prisma: { $transaction: ReturnType<typeof vi.fn> }
} {
  const prisma = { $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({})) }
  return { service: new AuthorizationService(prisma as never), prisma }
}

const request: AuthorizationRequest = {
  businessUserId: 'u1',
  tenantId: 't1',
  capability: 'answer.run',
}

beforeEach(() => {
  capabilitiesMock.mockReset()
  scopesMock.mockReset()
  recheckMock.mockReset()
  auditMock.mockReset()
  auditMock.mockResolvedValue({ auditEventId: 'evt-1' })
})

describe('能力层', () => {
  it('能力齐备且无资源 → 允许，审计 ALLOWED + capability_allowed', async () => {
    capabilitiesMock.mockResolvedValue({ ok: true, capabilities: new Set(['answer.run']) })
    const { service } = makeService()
    const decision = await service.authorize(request)
    expect(decision).toEqual({ allowed: true })
    expect(auditMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ reasonCode: 'authz.capability_allowed', outcome: 'ALLOWED' }),
    )
  })

  it('成员失效与能力缺失都拒绝 CAPABILITY_MISSING（对调用方同一个原因）', async () => {
    capabilitiesMock.mockResolvedValue({ ok: false, reason: 'NO_ACTIVE_TENANT_MEMBERSHIP' })
    const { service } = makeService()
    expect(await service.authorize(request)).toEqual({
      allowed: false,
      reason: 'CAPABILITY_MISSING',
    })

    capabilitiesMock.mockResolvedValue({ ok: true, capabilities: new Set(['document.upload']) })
    expect(await service.authorize(request)).toEqual({
      allowed: false,
      reason: 'CAPABILITY_MISSING',
    })
    expect(auditMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ reasonCode: 'authz.capability_denied', outcome: 'DENIED' }),
    )
  })
})

describe('资源层', () => {
  const resourceRequest: AuthorizationRequest = {
    businessUserId: 'u1',
    tenantId: 't1',
    capability: 'answer.run',
    resource: { kind: 'knowledge_space', knowledgeSpaceId: 'ks1' },
  }

  it('资源在允许作用域内 → 允许', async () => {
    capabilitiesMock.mockResolvedValue({ ok: true, capabilities: new Set(['answer.run']) })
    scopesMock.mockResolvedValue({
      ok: true,
      scopes: { aclRevision: 3, scopeKeys: ['t:t1:ks:ks1', 't:t1:ks:ks2'] },
    })
    const { service } = makeService()
    expect(await service.authorize(resourceRequest)).toEqual({ allowed: true })
    expect(scopesMock).toHaveBeenCalledWith(expect.anything(), {
      businessUserId: 'u1',
      tenantId: 't1',
    })
  })

  it('资源不在作用域 → SCOPE_DENIED，成员失效同样 SCOPE_DENIED（不区分泄漏存在性）', async () => {
    capabilitiesMock.mockResolvedValue({ ok: true, capabilities: new Set(['answer.run']) })
    scopesMock.mockResolvedValue({
      ok: true,
      scopes: { aclRevision: 3, scopeKeys: ['t:t1:ks:other'] },
    })
    const { service } = makeService()
    expect(await service.authorize(resourceRequest)).toEqual({
      allowed: false,
      reason: 'SCOPE_DENIED',
    })

    scopesMock.mockResolvedValue({ ok: false, reason: 'NO_ACTIVE_TENANT_MEMBERSHIP' })
    expect(await service.authorize(resourceRequest)).toEqual({
      allowed: false,
      reason: 'SCOPE_DENIED',
    })
    expect(auditMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ reasonCode: 'authz.scope_denied', outcome: 'DENIED' }),
    )
  })

  it('document_version 资源还要过复核：候选被拒 → SCOPE_DENIED', async () => {
    capabilitiesMock.mockResolvedValue({ ok: true, capabilities: new Set(['answer.run']) })
    scopesMock.mockResolvedValue({
      ok: true,
      scopes: { aclRevision: 3, scopeKeys: ['t:t1:ks:ks1'] },
    })
    recheckMock.mockResolvedValue({ allowed: [], rejected: ['dv1'] })
    const { service } = makeService()
    const decision = await service.authorize({
      ...request,
      resource: { kind: 'document_version', knowledgeSpaceId: 'ks1', documentVersionId: 'dv1' },
    })
    expect(decision).toEqual({ allowed: false, reason: 'SCOPE_DENIED' })
    expect(recheckMock).toHaveBeenCalledWith(expect.anything(), {
      tenantId: 't1',
      knowledgeSpaceId: 'ks1',
      documentVersionIds: ['dv1'],
    })
  })
})

describe('fail closed 纪律', () => {
  it('查库抛错 → DEPENDENCY_UNAVAILABLE，审计 DEGRADED', async () => {
    capabilitiesMock.mockRejectedValue(new Error('ECONNREFUSED'))
    const { service } = makeService()
    const decision = await service.authorize(request)
    expect(decision).toEqual({ allowed: false, reason: 'DEPENDENCY_UNAVAILABLE' })
    expect(auditMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        reasonCode: 'authz.dependency_unavailable',
        outcome: 'DEGRADED',
      }),
    )
  })

  it('拒绝路径的审计写失败不推翻拒绝', async () => {
    capabilitiesMock.mockResolvedValue({ ok: true, capabilities: new Set() })
    auditMock.mockRejectedValue(new Error('audit down'))
    const { service } = makeService()
    // 不抛：拒绝已成立。
    expect(await service.authorize(request)).toEqual({
      allowed: false,
      reason: 'CAPABILITY_MISSING',
    })
  })

  it('允许路径的审计写失败必须不放行（向上抛，调用方得到 5xx）', async () => {
    capabilitiesMock.mockResolvedValue({ ok: true, capabilities: new Set(['answer.run']) })
    auditMock.mockRejectedValue(new Error('audit down'))
    const { service } = makeService()
    await expect(service.authorize(request)).rejects.toThrow('audit down')
  })

  it('审计带 traceId 与资源主体（可审计到「谁对什么资源做了什么判定」）', async () => {
    capabilitiesMock.mockResolvedValue({ ok: true, capabilities: new Set(['answer.run']) })
    const { service } = makeService()
    await service.authorize(
      {
        ...request,
        resource: { kind: 'document_version', knowledgeSpaceId: 'ks1', documentVersionId: 'dv1' },
      },
      { traceId: 'trace-1' },
    )
    expect(auditMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        traceId: 'trace-1',
        subject: { type: 'document_version', id: 'dv1' },
      }),
    )
  })
})
