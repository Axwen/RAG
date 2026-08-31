import { z } from 'zod'
import {
  CANDIDATE_BUDGET_FROZEN,
  RERANK_INPUT_SIZE_SEED,
  SOURCE_FORMATS,
  PARSE_BACKENDS,
} from '@rag/contracts'

/**
 * T1a Manifest 端点的请求体 schema。
 *
 * rerankInputSize/candidateBudget 由 Manifest 固化（种子写 64 / 冻结 1024），
 * 不接受环境变量或前端覆盖（PROBE-005 裁决）。
 */

export const ingestionManifestCreateSchema = z.object({
  tenantId: z.uuid(),
  version: z.number().int().positive(),
  parserRef: z.string().min(1),
  chunkerRef: z.string().min(1),
  embeddingRef: z.string().min(1),
  indexSchemaRef: z.string().min(1),
  parseBackend: z.enum(PARSE_BACKENDS).default('deepdoc'),
  sourceFormats: z.array(z.enum(SOURCE_FORMATS)).min(1),
})

export const retrievalManifestCreateSchema = z.object({
  tenantId: z.uuid(),
  version: z.number().int().positive(),
  sparsePolicy: z.record(z.string(), z.unknown()),
  vectorPolicy: z
    .object({
      channels: z
        .array(
          z.object({
            name: z.string().min(1),
            embeddingRef: z.string().min(1),
            dimension: z.number().int().positive(),
          }),
        )
        .min(1),
    })
    .passthrough(),
  fusionPolicy: z.record(z.string(), z.unknown()),
  rerankerRef: z.string().min(1),
  candidateBudget: z.literal(CANDIDATE_BUDGET_FROZEN),
  rerankInputSize: z
    .number()
    .int()
    .positive()
    .max(CANDIDATE_BUDGET_FROZEN)
    .default(RERANK_INPUT_SIZE_SEED),
})

export const answerManifestCreateSchema = z.object({
  tenantId: z.uuid(),
  version: z.number().int().positive(),
  promptRef: z.string().min(1),
  modelRouteRef: z.string().min(1),
  citationPolicy: z.record(z.string(), z.unknown()),
  riskPolicy: z.record(z.string(), z.unknown()),
  fallbackPolicy: z.record(z.string(), z.unknown()),
})

export const pipelineManifestCreateSchema = z.object({
  tenantId: z.uuid(),
  version: z.number().int().positive(),
  ingestionManifestId: z.uuid(),
  retrievalManifestId: z.uuid(),
  answerManifestId: z.uuid(),
})

export const releaseManifestCreateSchema = z.object({
  tenantId: z.uuid(),
  knowledgeSpaceId: z.uuid(),
  indexPartitionId: z.uuid(),
  ingestionManifestId: z.uuid(),
  memberSetUri: z.string().min(1),
  memberSetHash: z.string().min(1),
  memberCount: z.number().int().nonnegative(),
  docIndexName: z.string().min(1),
  chunkIndexName: z.string().min(1),
  candidateAlias: z.string().min(1),
})

export type IngestionManifestCreateInput = z.infer<typeof ingestionManifestCreateSchema>
export type RetrievalManifestCreateInput = z.infer<typeof retrievalManifestCreateSchema>
export type AnswerManifestCreateInput = z.infer<typeof answerManifestCreateSchema>
export type PipelineManifestCreateInput = z.infer<typeof pipelineManifestCreateSchema>
export type ReleaseManifestCreateInput = z.infer<typeof releaseManifestCreateSchema>
