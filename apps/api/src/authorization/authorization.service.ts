import { Injectable } from '@nestjs/common'
import type {
  AuthorizationDecision,
  AuthorizationRequest,
  AuthorizationResource,
} from '@rag/contracts'
import {
  compileAllowedScopes,
  recheckCandidates,
  resolveCapabilities,
  writeAuditEvent,
} from '@rag/database'
import { createLogger } from '@rag/observability'
import type { PrismaService } from '../database/prisma.service'

/**
 * 统一授权入口（T14b / ADR-0039 决策 2）。
 *
 * 输入五元组，输出一个决策；调用方不得拆层自行组合。两层判定的顺序是
 * 先能力后资源：能力缺失时连资源都不该被读取（「能不能做这件事」先于
 * 「这件事涉及的数据可不可见」）。
 *
 * 每次判定写一行同步领域审计（T14 DoD）：允许与拒绝都写，原因码取
 * T11a 中央注册表的 authz.*。审计写失败的语义分方向——拒绝路径的结论
 * 已经安全，审计失败只进日志；允许路径审计写不进去就不得放行（fail
 * closed，决策翻转为 DEPENDENCY_UNAVAILABLE）。「Trace/Telemetry 故障
 * 不影响拒绝结果」的同一条纪律：拒绝永远成立。
 *
 * 依赖不可用（数据库查询抛错）：fail closed，返回 DEPENDENCY_UNAVAILABLE
 * 并以 DEGRADED outcome 写审计（若审计本身也不可用，则只剩日志）。
 */

@Injectable()
export class AuthorizationService {
  private readonly logger = createLogger({ bindings: { service: 'api' } })

  constructor(private readonly prisma: PrismaService) {}

  async authorize(
    request: AuthorizationRequest,
    options: { readonly traceId?: string } = {},
  ): Promise<AuthorizationDecision> {
    let decision: AuthorizationDecision
    let auditOutcome: 'ALLOWED' | 'DENIED' | 'DEGRADED'
    let reasonCode: 'authz.capability_allowed' | 'authz.capability_denied' | 'authz.scope_denied' | 'authz.dependency_unavailable'

    try {
      const capabilities = await resolveCapabilities(this.prisma, {
        businessUserId: request.businessUserId,
        tenantId: request.tenantId,
        ...(request.workspaceId === undefined ? {} : { workspaceId: request.workspaceId }),
      })
      if (!capabilities.ok) {
        decision = { allowed: false, reason: 'CAPABILITY_MISSING' }
        reasonCode = 'authz.capability_denied'
        auditOutcome = 'DENIED'
      } else if (!capabilities.capabilities.has(request.capability)) {
        decision = { allowed: false, reason: 'CAPABILITY_MISSING' }
        reasonCode = 'authz.capability_denied'
        auditOutcome = 'DENIED'
      } else if (request.resource !== undefined) {
        decision = await this.checkResource(request.businessUserId, request.tenantId, request.resource)
        reasonCode = decision.allowed ? 'authz.capability_allowed' : 'authz.scope_denied'
        auditOutcome = decision.allowed ? 'ALLOWED' : 'DENIED'
      } else {
        decision = { allowed: true }
        reasonCode = 'authz.capability_allowed'
        auditOutcome = 'ALLOWED'
      }
    } catch (cause) {
      // 依赖不可用：fail closed。细节进日志（带 traceId），不进决策。
      this.logger.warn(
        { err: cause instanceof Error ? cause.message : String(cause), traceId: options.traceId },
        '授权依赖不可用，fail closed',
      )
      decision = { allowed: false, reason: 'DEPENDENCY_UNAVAILABLE' }
      reasonCode = 'authz.dependency_unavailable'
      auditOutcome = 'DEGRADED'
    }

    await this.writeDecisionAudit(request, decision, reasonCode, auditOutcome, options.traceId)
    return decision
  }

  /**
   * 资源策略层（阶段 1 纯作用域型，ADR-0026）：资源所属知识空间必须在
   * 主体的允许作用域键集合内。数据等级拒绝在这里做——文档版本的等级
   * 不参与作用域键（键粒度到知识空间），SENSITIVE/UNKNOWN 拒绝是策略
   * 判定不是过滤键判定。
   */
  private async checkResource(
    businessUserId: string,
    tenantId: string,
    resource: AuthorizationResource,
  ): Promise<AuthorizationDecision> {
    const scopes = await compileAllowedScopes(this.prisma, { businessUserId, tenantId })
    if (!scopes.ok) return { allowed: false, reason: 'SCOPE_DENIED' }

    const resourceKey =
      resource.kind === 'knowledge_space'
        ? `t:${tenantId}:ks:${resource.knowledgeSpaceId}`
        : `t:${tenantId}:ks:${resource.knowledgeSpaceId}`
    if (!scopes.ok || !scopes.scopes.scopeKeys.includes(resourceKey)) {
      return { allowed: false, reason: 'SCOPE_DENIED' }
    }

    // document_version 还要过候选复核（同一批量入口，单资源退化形态）：
    // 版本必须真实存在于本租户。存在性 + 墓碑/有效期的未来项都在这一跳。
    if (resource.kind === 'document_version') {
      const recheck = await recheckCandidates(this.prisma, {
        tenantId,
        knowledgeSpaceId: resource.knowledgeSpaceId,
        documentVersionIds: [resource.documentVersionId],
      })
      if (!recheck.allowed.includes(resource.documentVersionId)) {
        return { allowed: false, reason: 'SCOPE_DENIED' }
      }
    }
    return { allowed: true }
  }

  /** 决策审计。拒绝路径审计失败只记日志；允许路径审计失败把决策翻转为 fail closed。 */
  private async writeDecisionAudit(
    request: AuthorizationRequest,
    decision: AuthorizationDecision,
    reasonCode: 'authz.capability_allowed' | 'authz.capability_denied' | 'authz.scope_denied' | 'authz.dependency_unavailable',
    outcome: 'ALLOWED' | 'DENIED' | 'DEGRADED',
    traceId: string | undefined,
  ): Promise<void> {
    const subject =
      request.resource === undefined
        ? undefined
        : request.resource.kind === 'knowledge_space'
          ? { type: 'knowledge_space', id: request.resource.knowledgeSpaceId }
          : { type: 'document_version', id: request.resource.documentVersionId }
    try {
      await this.prisma.$transaction((tx) =>
        writeAuditEvent(tx, {
          tenantId: request.tenantId,
          reasonCode,
          outcome,
          actor: { businessUserId: request.businessUserId },
          ...(subject === undefined ? {} : { subject }),
          detail: {
            capability: request.capability,
            workspaceId: request.workspaceId ?? null,
            denialReason: decision.allowed ? null : decision.reason,
          },
          ...(traceId === undefined ? {} : { traceId }),
        }),
      )
    } catch (cause) {
      if (!decision.allowed) {
        // 拒绝已成立，审计失败不推翻它——但必须留痕。
        this.logger.error(
          { err: cause instanceof Error ? cause.message : String(cause), reasonCode, traceId },
          '授权拒绝的审计写入失败（拒绝结论不受影响）',
        )
        return
      }
      // 允许路径审计写不进去：不放行。向上抛让调用方得到 5xx（fail closed），
      // 而不是把「已允许但无审计」的行返回给业务代码。
      throw cause
    }
  }
}
