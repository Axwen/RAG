import type { ProviderExecutionIdentity, ProviderRunStatus } from '@rag/contracts'

export interface ProviderWriteAcceptanceContext {
  readonly currentSourceVersionId: string
  readonly currentRunId: string
  readonly currentGeneration: number
  readonly currentInputFingerprint: string
  readonly currentAttempt: number
  readonly currentStatus: ProviderRunStatus
}

/**
 * 结果写回前的公共门禁。数据库 CAS、队列 ACK 和索引事务由运行时 Adapter 负责；
 * 该函数只固定最小一致性规则，防止取消、重试或新输入的迟到结果污染当前状态。
 */
export function canAcceptProviderResult(
  current: ProviderWriteAcceptanceContext,
  result: ProviderExecutionIdentity,
): boolean {
  if (current.currentStatus !== 'running' && current.currentStatus !== 'retrying') return false
  return (
    result.sourceVersionId === current.currentSourceVersionId &&
    result.runId === current.currentRunId &&
    result.generation === current.currentGeneration &&
    result.inputFingerprint === current.currentInputFingerprint &&
    result.attempt === current.currentAttempt
  )
}
