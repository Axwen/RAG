import { Injectable } from '@nestjs/common'
import type {
  AuthorizationDecision,
  AuthorizationDenialReason,
  AuthorizationRequest,
  AuthorizationResource,
  AuthzReasonCode,
} from '@rag/contracts'
import { scopeKeyForKnowledgeSpace, stage1DeniedDataClasses } from '@rag/contracts'
import {
  compileAllowedScopes,
  recheckCandidates,
  resolveCapabilities,
  writeAuditEvent,
} from '@rag/database'
import { createLogger } from '@rag/observability'
import { PrismaService } from '../database/prisma.service'

/**
 * 统一授权入口（T14b / ADR-0039 决策 2）。
 *
 * 输入五元组，输出一个决策；调用方不得拆层自行组合。两层判定的顺序是
 * 先能力后资源：能力缺失时连资源都不该被读取（「能不能做这件事」先于
 * 「这件事涉及的数据可不可见」）。
 *
 * 每次判定写一行同步领域审计（T14 DoD）：允许与拒绝都写，原因码取
 * T11a 中央注册表的 authz.*。领域审计是业务事务的一部分，任何方向的
 * 审计写失败都必须让本次业务操作失败（ADR-0040），不得按遥测语义吞掉。
 *
 * 依赖不可用（数据库查询抛错）：fail closed，返回 DEPENDENCY_UNAVAILABLE
 * 并以 DEGRADED outcome 写审计；审计写入本身失败时继续向上抛出。
 */

/** 拒绝原因 → 审计码，四类各一枚注册表码。契约测试钉住这个双射。 */
const DENIAL_AUDIT_CODE = {
  CAPABILITY_MISSING: 'authz.capability_denied',
  SCOPE_DENIED: 'authz.scope_denied',
  DATA_CLASS_DENIED: 'authz.dataclass_denied',
  DEPENDENCY_UNAVAILABLE: 'authz.dependency_unavailable',
} as const satisfies Record<AuthorizationDenialReason, AuthzReasonCode>

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

    try {
      const capabilities = await resolveCapabilities(this.prisma, {
        businessUserId: request.businessUserId,
        tenantId: request.tenantId,
        ...(request.workspaceId === undefined ? {} : { workspaceId: request.workspaceId }),
      })
      if (!capabilities.ok || !capabilities.capabilities.has(request.capability)) {
        // 成员失效与能力缺失对调用方是同一个原因：都是「不能执行这个操作」。
        decision = { allowed: false, reason: 'CAPABILITY_MISSING' }
        auditOutcome = 'DENIED'
      } else if (request.resource !== undefined) {
        decision = await this.checkResource(
          request.businessUserId,
          request.tenantId,
          request.resource,
          request.workspaceId,
        )
        auditOutcome = decision.allowed ? 'ALLOWED' : 'DENIED'
      } else {
        decision = { allowed: true }
        auditOutcome = 'ALLOWED'
      }
    } catch (cause) {
      // 依赖不可用：fail closed。细节进日志（带 traceId），不进决策。
      this.logger.warn(
        { err: cause instanceof Error ? cause.message : String(cause), traceId: options.traceId },
        '授权依赖不可用，fail closed',
      )
      decision = { allowed: false, reason: 'DEPENDENCY_UNAVAILABLE' }
      auditOutcome = 'DEGRADED'
    }

    const reasonCode: AuthzReasonCode = decision.allowed
      ? 'authz.capability_allowed'
      : DENIAL_AUDIT_CODE[decision.reason]
    await this.writeDecisionAudit(request, decision, reasonCode, auditOutcome, options.traceId)
    return decision
  }

  /**
   * 资源策略层（ADR-0039 决策 2），两个判定：
   *
   * 1. 作用域：资源所属知识空间必须在主体的允许作用域键集合内。键粒度
   *    到知识空间（ADR-0026/0037），格式由 contracts 的
   *    `scopeKeyForKnowledgeSpace` 唯一定义，这里不手拼第二份。
   * 2. 数据等级：document_version 的 dataClass 落在 stage1DeniedDataClasses
   *    （UNKNOWN/SENSITIVE）时拒绝——阶段 1 无 clearance 模型，fail closed。
   *    注意这**不是**候选复核的减法项：SENSITIVE 检索候选仍要被召回，
   *    由 T15 准入层按执行区阻断（ADR-0025），两层职责不得互换。
   *
   * document_version 还要过候选复核（同一批量入口，单资源退化形态）：
   * 版本必须真实存在于本租户。存在性 + 墓碑/有效期的未来项都在这一跳。
   */
  private async checkResource(
    businessUserId: string,
    tenantId: string,
    resource: AuthorizationResource,
    workspaceId: string | undefined,
  ): Promise<AuthorizationDecision> {
    const scopes = await compileAllowedScopes(this.prisma, {
      businessUserId,
      tenantId,
      ...(workspaceId === undefined ? {} : { workspaceId }),
    })
    if (!scopes.ok) return { allowed: false, reason: 'SCOPE_DENIED' }

    const resourceKey = scopeKeyForKnowledgeSpace(tenantId, resource.knowledgeSpaceId)
    if (!scopes.scopes.scopeKeys.includes(resourceKey)) {
      return { allowed: false, reason: 'SCOPE_DENIED' }
    }

    if (resource.kind === 'document_version') {
      const recheck = await recheckCandidates(this.prisma, {
        tenantId,
        knowledgeSpaceId: resource.knowledgeSpaceId,
        documentVersionIds: [resource.documentVersionId],
      })
      const dataClass = recheck.dataClasses[resource.documentVersionId]
      if (dataClass === undefined) {
        // 复核减法把它剔了：不存在、跨租户或不在该知识空间。
        return { allowed: false, reason: 'SCOPE_DENIED' }
      }
      if (stage1DeniedDataClasses.includes(dataClass)) {
        return { allowed: false, reason: 'DATA_CLASS_DENIED' }
      }
    }
    return { allowed: true }
  }

  /** 决策审计属于业务结果；写入失败一律向上抛。 */
  private async writeDecisionAudit(
    request: AuthorizationRequest,
    decision: AuthorizationDecision,
    reasonCode: AuthzReasonCode,
    outcome: 'ALLOWED' | 'DENIED' | 'DEGRADED',
    traceId: string | undefined,
  ): Promise<void> {
    const subject =
      request.resource === undefined
        ? undefined
        : request.resource.kind === 'knowledge_space'
          ? { type: 'knowledge_space', id: request.resource.knowledgeSpaceId }
          : { type: 'document_version', id: request.resource.documentVersionId }
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
  }
}
