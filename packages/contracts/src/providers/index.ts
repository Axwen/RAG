/** Provider、Artifact 与 Job 运行契约（ADR-0043）。 */

export const PROVIDER_TASK_TYPES = [
  'probe',
  'media_extract',
  'segmentation',
  'subtitle',
  'speech',
  'ocr',
  'visual_embedding',
  'caption',
  'text_embedding',
  'rerank',
  'generation',
  'citation_verification',
] as const
export type ProviderTaskType = (typeof PROVIDER_TASK_TYPES)[number]

export const PROVIDER_RUN_STATUSES = [
  'queued',
  'running',
  'retrying',
  'succeeded',
  'failed',
  'cancelled',
  'expired',
  'superseded',
] as const
export type ProviderRunStatus = (typeof PROVIDER_RUN_STATUSES)[number]

export const JOB_EVENT_TYPES = [
  'queued',
  'started',
  'progress',
  'artifact_produced',
  'succeeded',
  'failed',
  'cancel_requested',
  'cancelled',
  'retry_scheduled',
  'recovered',
  'superseded',
] as const
export type JobEventType = (typeof JOB_EVENT_TYPES)[number]

export interface ProviderExecutionIdentity {
  readonly sourceVersionId: string
  readonly providerRef: string
  readonly providerVersion: string
  readonly modelRef: string | null
  readonly modelVersion: string | null
  readonly inputFingerprint: string
  readonly runId: string
  readonly generation: number
  readonly attempt: number
}

export interface ProviderArtifact extends ProviderExecutionIdentity {
  readonly artifactId: string
  readonly artifactType:
    | 'media_metadata'
    | 'audio'
    | 'keyframe'
    | 'thumbnail'
    | 'subtitle'
    | 'transcript'
    | 'ocr'
    | 'caption'
    | 'embedding'
    | 'parse'
    | 'index_projection'
  readonly outputFingerprint: string
  /** URI、文件键或本地相对引用；公共契约不解释其存储实现。 */
  readonly storageRef: string
  readonly contentHash: string
  readonly mimeType: string | null
  readonly sizeBytes: number | null
  readonly producedAt: string
}

export interface ProviderRun extends ProviderExecutionIdentity {
  readonly jobId: string
  readonly taskType: ProviderTaskType
  readonly status: ProviderRunStatus
  readonly outputFingerprint: string | null
  readonly requestedAt: string
  readonly startedAt: string | null
  readonly finishedAt: string | null
  readonly artifactIds: readonly string[]
  readonly errorCode: string | null
}

export interface JobEvent {
  readonly eventId: string
  readonly jobId: string
  readonly runId: string
  readonly sourceVersionId: string
  readonly generation: number
  readonly attempt: number
  readonly sequence: number
  readonly type: JobEventType
  readonly occurredAt: string
  /** 只放进度、阶段和错误摘要等受控元数据，不放正文、媒体或思维链。 */
  readonly payload: Readonly<Record<string, unknown>>
}

export interface ProviderValidationIssue {
  readonly path: string
  readonly message: string
}
