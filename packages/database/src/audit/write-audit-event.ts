import { categoryForReasonCode, isReasonCode, type ReasonCode } from '@rag/contracts'
import type { Prisma } from '../generated/prisma/client'
import type { Tx } from '../tx'
import { txNow } from '../tx-clock'
import { redactAuditDetail } from './redact-detail'

/**
 * 唯一的领域审计写入口（T11a [审计写入口契约] / ADR-0040 决策 1、4）。
 *
 * 三条约束在这个文件里成立，改动时不要「顺手放宽」：
 * 1. **没有自建事务的重载，也没有 fire-and-forget 版本。** 只接受已开启的 `tx`，
 *    「拿不到事务就写不了审计」在类型上成立。
 * 2. **不返回软失败。** 写不进去就抛，让外层事务连业务写入一起回滚。这是与遥测入口
 *    最本质的区别：遥测失败必须被吞，审计失败必须炸。
 * 3. **调用方不构造 `id` 与 `occurredAt`。** `id` 走 `@default(uuid(7))`；`occurredAt` 取
 *    `txNow(tx)`（`CURRENT_TIMESTAMP`，PostgreSQL 返回事务开始时间），所以同一个 `tx` 里的
 *    多条审计与业务行时间一致，调用方的本地时钟写不出乱序的审计行。
 *    这里**不能**靠列的 `DEFAULT CURRENT_TIMESTAMP`：Prisma Client 会在客户端为
 *    `@default(now())` 生成值再发过去，列默认值只对省略该列的写入者（原始 SQL）生效——
 *    实测同一事务里两次 `create()` 的 `occurredAt` 差几毫秒。列默认值留着当兜底。
 *
 * 不提供 `writeAuditEvents(events[])`：lease 回收一次回收 N 行要写 N 条审计，逐条写
 * 才能让其中一条脱敏失败时整批回滚。
 */

export type AuditActor = { businessUserId: string } | { system: 'LEASE_REAPER' | 'RECONCILER' }

export interface AuditEventInput {
  tenantId: string
  /**
   * 不传 `category`：它由注册表按 `reasonCode` 派生（`categoryForReasonCode`），
   * 否则调用方可以写出 category=AUTHZ + reasonCode=budget.* 这种自相矛盾的行。
   */
  reasonCode: ReasonCode
  /** 读侧统一口径，不由 `reasonCode` 反推：同一个码在不同调用点可能是 DENIED 也可能是 DEGRADED。 */
  outcome: 'ALLOWED' | 'DENIED' | 'DEGRADED' | 'RECLAIMED'
  /** 省略即 `actorType=SYSTEM` 且 `actorId` 为空；传 `{ system }` 时 `actorId` 记系统动作名。 */
  actor?: AuditActor
  /** 被判定的资源，映射到 `subjectType` + `subjectId` 两列（库里两列必须同时有或同时无）。 */
  subject?: { type: string; id: string }
  /** 结构化补充信息。写入前强制过脱敏，因此可以放判定依据，不能放正文。 */
  detail?: Record<string, unknown>
  /** 与本次业务事务同一个 traceId，便于把审计行与日志对上。 */
  traceId?: string
}

/**
 * `traceId` 的两种合法形状，与 T1a 错误信封的 `trace_id` 同一口径：
 * W3C `traceparent` 的 trace-id 段（32 位小写十六进制），或服务端在缺失时自己生成的
 * UUID（`apps/api/src/common/global-exception.filter.ts` 的 `resolveTraceId` 两个分支）。
 *
 * 这里不接受任意字符串：审计行不可变且不随业务数据删除，一个未经校验的客户端头会永久留在
 * 库里。也不能只收 32 位十六进制——那会让所有没带 traceparent 的请求（本地开发的绝大多数）
 * 的审计行对不上日志，与「便于把审计行与日志对上」矛盾。
 *
 * 正则与信封侧刻意各自成立：那边校验的是「HTTP 头里这一段是否合法 W3C trace-id」，
 * 这里校验的是「已解析出来的 traceId 是否出自我们自己的解析器」，两个问题不同。
 */
const traceIdPattern =
  /^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/

function actorColumns(actor: AuditActor | undefined): {
  actorType: 'BUSINESS_USER' | 'SYSTEM'
  actorId: string | null
} {
  if (actor === undefined) {
    return { actorType: 'SYSTEM', actorId: null }
  }
  if ('businessUserId' in actor) {
    // 库里有 CHECK：BUSINESS_USER 必须带 actorId。空串会绕过 NOT NULL 却让审计说不清是谁。
    if (actor.businessUserId === '') {
      throw new Error('审计 actor.businessUserId 为空：BUSINESS_USER 必须有判定主体')
    }
    return { actorType: 'BUSINESS_USER', actorId: actor.businessUserId }
  }
  return { actorType: 'SYSTEM', actorId: actor.system }
}

/** 写一条领域审计。任何校验失败都抛，由外层事务整体回滚。 */
export async function writeAuditEvent(
  tx: Tx,
  event: AuditEventInput,
): Promise<{ auditEventId: string }> {
  // 编译期由 satisfies + ReasonCode 保证已注册；这里兜住 `as` 断言与纯 JS 调用方。
  // 未注册的码进库是缺陷不是灵活性，所以 fail closed 而不是回退到某个默认 category。
  if (!isReasonCode(event.reasonCode)) {
    throw new Error(`审计 reasonCode 未注册：${String(event.reasonCode)}`)
  }
  if (event.tenantId === '') {
    throw new Error('审计 tenantId 为空：审计读取必带租户谓词，无租户的行读不出来')
  }
  if (event.traceId !== undefined && !traceIdPattern.test(event.traceId)) {
    throw new Error('审计 traceId 形状非法：只接受严格校验过的 traceparent trace-id 或服务端 UUID')
  }

  const { actorType, actorId } = actorColumns(event.actor)
  const occurredAt = await txNow(tx)
  const created = await tx.domainAuditEvent.create({
    data: {
      tenantId: event.tenantId,
      // 显式传库时钟，见文件头第 3 条：Prisma 的 `@default(now())` 是客户端生成的。
      occurredAt,
      category: categoryForReasonCode(event.reasonCode),
      reasonCode: event.reasonCode,
      outcome: event.outcome,
      actorType,
      actorId,
      subjectType: event.subject?.type ?? null,
      subjectId: event.subject?.id ?? null,
      // 条件展开而不是 `detail: undefined`：仓库开了 exactOptionalPropertyTypes，
      // 显式的 undefined 不等于「不传这个键」。不传时列保持 NULL。
      ...(event.detail === undefined
        ? {}
        : { detail: redactAuditDetail(event.detail) as Prisma.InputJsonValue }),
      traceId: event.traceId ?? null,
    },
    select: { id: true },
  })
  return { auditEventId: created.id }
}
