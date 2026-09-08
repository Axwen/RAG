import type { CandidateRecheckResult } from '@rag/contracts'
import type { PrismaClient } from '../generated/prisma/client'
import type { Tx } from '../tx'

/**
 * 候选权威复核（T14b / ADR-0026 第二段授权）。
 *
 * 召回结果合并后、融合与 Rerank 之前，对候选的 documentVersionId 集合做
 * **一次**批量查询，复核每个候选仍是本租户内真实存在的文档版本。禁止
 * 逐候选查询（ADR-0026 原文）。被拒的候选直接丢弃，不进入证据、引用与
 * Trace 摘要——复核只能做减法，正向授权只能放在第一段预过滤。
 *
 * 阶段 1 已实现的复核项：候选存在性 + 租户归属（+ 可选知识空间归属）。
 * 删除墓碑、Legal Hold 与有效期随 T5/T8 的列落地逐项加入——列出现时
 * 只在这个查询的 WHERE 里加条件，形状保持批量单查询。
 *
 * 数据库不可用时的 fail closed 不在这里：查询抛异常向上传播，由调用方
 * （检索链路）映射 evidence unavailable，绝不以「跳过复核」放行候选。
 */

type Reader = PrismaClient | Tx

export interface CandidateRecheckInput {
  readonly tenantId: string
  /** 可选：候选应属于的知识空间（检索按知识空间发起时提供）。 */
  readonly knowledgeSpaceId?: string
  readonly documentVersionIds: readonly string[]
}

export async function recheckCandidates(
  reader: Reader,
  input: CandidateRecheckInput,
): Promise<CandidateRecheckResult> {
  if (input.documentVersionIds.length === 0) {
    return { allowed: [], rejected: [] }
  }

  // document_versions 的 (tenantId, id) 唯一索引让这次 IN 查询走索引扫描；
  // 候选上限由检索配置约束（阶段 1 为 candidateBudget 1024）。
  const found = await reader.documentVersion.findMany({
    where: {
      tenantId: input.tenantId,
      id: { in: [...input.documentVersionIds] },
      ...(input.knowledgeSpaceId === undefined
        ? {}
        : { document: { knowledgeSpaceId: input.knowledgeSpaceId } }),
    },
    select: { id: true },
  })
  const allowedSet = new Set(found.map((row) => row.id))

  const allowed: string[] = []
  const rejected: string[] = []
  // 输入去重但保持输出顺序：调用方按原候选顺序消费，重排会让融合与
  // Rerank 的确定性排序失去输入基础。
  const seen = new Set<string>()
  for (const id of input.documentVersionIds) {
    if (seen.has(id)) continue
    seen.add(id)
    if (allowedSet.has(id)) {
      allowed.push(id)
    } else {
      rejected.push(id)
    }
  }
  return { allowed, rejected }
}
