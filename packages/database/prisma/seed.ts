import { config as loadDotenv } from 'dotenv'
import { existsSync } from 'node:fs'
import path from 'node:path'
import {
  CANDIDATE_BUDGET_FROZEN,
  RERANK_INPUT_SIZE_SEED,
  compatibilityHashOf,
  contentHashOf,
  type AnswerManifestContent,
  type IngestionManifestContent,
  type RetrievalManifestContent,
} from '@rag/contracts'
import { createPrismaClient } from '../src/client'

/**
 * T1a 开发种子（幂等；init-database.sh 会在迁移后调用）。
 *
 * 口径（工程评审闭合记录 §4.2 / PROBE-005）：
 * - `rerankInputSize` 显式写 64（RERANK_INPUT_SIZE_SEED），不从环境变量读取；
 *   正式值由 T6 在真实业务语料上比较后拍板。
 * - `candidateBudget` 使用 ADR-0035 冻结值 1024。
 * - 种子实体使用固定 UUID，重复执行 upsert 不产生重复行。
 */

// 固定种子 ID：幂等键。只用于本地开发种子，不进入运行时代码路径。
const TENANT_ID = '018f0000-0000-7000-8000-000000000001'
const SPACE_ID = '018f0000-0000-7000-8000-000000000010'
const INGESTION_ID = '018f0000-0000-7000-8000-000000000030'
const RETRIEVAL_ID = '018f0000-0000-7000-8000-000000000031'
const ANSWER_ID = '018f0000-0000-7000-8000-000000000032'
const PIPELINE_ID = '018f0000-0000-7000-8000-000000000033'
const PARTITION_ID = '018f0000-0000-7000-8000-000000000020'

const ingestionContent: IngestionManifestContent = {
  kind: 'ingestion',
  tenantId: TENANT_ID,
  version: 1,
  parserRef: 'deepdoc@1.0.0',
  chunkerRef: 'wide-1024@1.0.0',
  embeddingRef: 'bge-m3@1.0.0',
  indexSchemaRef: 'index-schema@1',
  parseBackend: 'deepdoc',
  sourceFormats: ['pdf', 'md', 'json', 'csv'],
}

const retrievalContent: RetrievalManifestContent = {
  kind: 'retrieval',
  tenantId: TENANT_ID,
  version: 1,
  sparsePolicy: { analyzer: 'cjk' },
  vectorPolicy: {
    channels: [{ name: 'main', embeddingRef: 'bge-m3@1.0.0', dimension: 1024 }],
  },
  fusionPolicy: { weights: { sparse: 0.4, vector: 0.6 } },
  rerankerRef: 'qwen/qwen3-reranker-8b@1',
  candidateBudget: CANDIDATE_BUDGET_FROZEN,
  rerankInputSize: RERANK_INPUT_SIZE_SEED,
}

const answerContent: AnswerManifestContent = {
  kind: 'answer',
  tenantId: TENANT_ID,
  version: 1,
  promptRef: 'answer-prompt@1',
  modelRouteRef: 'gpt-5.6-terra@1',
  citationPolicy: { scope: 'PERSISTENT', verificationBudgetMs: { normal: 2000, highRisk: 3500 } },
  riskPolicy: { highRiskOutputTokenLimit: 2048 },
  fallbackPolicy: { onConflict: 'PARTIAL', onEvidenceOnly: 'EVIDENCE_ONLY' },
}

function loadRootEnv(): void {
  // 与 prisma.config.ts 同一口径：仓库根 .env，不覆盖已存在变量。
  let current = path.resolve(__dirname)
  while (!existsSync(path.join(current, 'pnpm-workspace.yaml'))) {
    const parent = path.dirname(current)
    if (parent === current) {
      return
    }
    current = parent
  }
  const envFile = path.join(current, '.env')
  if (existsSync(envFile)) {
    loadDotenv({ path: envFile, quiet: true })
  }
}

async function seed(): Promise<void> {
  loadRootEnv()
  const prisma = createPrismaClient()

  try {
    await prisma.tenant.upsert({
      where: { id: TENANT_ID },
      create: { id: TENANT_ID, name: 'local-dev' },
      update: {},
    })

    await prisma.knowledgeSpace.upsert({
      where: { id: SPACE_ID },
      create: {
        id: SPACE_ID,
        tenantId: TENANT_ID,
        slug: 'default',
        name: '默认知识空间',
      },
      update: {},
    })

    const ingestion = await prisma.ingestionManifest.upsert({
      where: { id: INGESTION_ID },
      create: {
        id: INGESTION_ID,
        tenantId: TENANT_ID,
        version: 1,
        status: 'APPROVED',
        parserRef: ingestionContent.parserRef,
        chunkerRef: ingestionContent.chunkerRef,
        embeddingRef: ingestionContent.embeddingRef,
        indexSchemaRef: ingestionContent.indexSchemaRef,
        // 每个参与 contentHash 的字段都必须显式写入：靠列默认值"凑巧等于"契约常量，
        // 一旦默认值或默认后端变化（T4b），种子行就无法复现自己的 contentHash，
        // 内容寻址不变量会在每个开发库里静默失效。
        parseBackend: ingestionContent.parseBackend,
        sourceFormats: [...ingestionContent.sourceFormats],
        contentHash: contentHashOf(ingestionContent),
        approvedAt: new Date(),
      },
      update: {},
    })

    const retrieval = await prisma.retrievalManifest.upsert({
      where: { id: RETRIEVAL_ID },
      create: {
        id: RETRIEVAL_ID,
        tenantId: TENANT_ID,
        version: 1,
        status: 'APPROVED',
        sparsePolicy: retrievalContent.sparsePolicy as object,
        vectorPolicy: retrievalContent.vectorPolicy as object,
        fusionPolicy: retrievalContent.fusionPolicy as object,
        rerankerRef: retrievalContent.rerankerRef,
        candidateBudget: retrievalContent.candidateBudget,
        rerankInputSize: retrievalContent.rerankInputSize,
        contentHash: contentHashOf(retrievalContent),
        approvedAt: new Date(),
      },
      update: {},
    })

    const answer = await prisma.answerManifest.upsert({
      where: { id: ANSWER_ID },
      create: {
        id: ANSWER_ID,
        tenantId: TENANT_ID,
        version: 1,
        status: 'APPROVED',
        promptRef: answerContent.promptRef,
        modelRouteRef: answerContent.modelRouteRef,
        citationPolicy: answerContent.citationPolicy as object,
        riskPolicy: answerContent.riskPolicy as object,
        fallbackPolicy: answerContent.fallbackPolicy as object,
        contentHash: contentHashOf(answerContent),
        approvedAt: new Date(),
      },
      update: {},
    })

    await prisma.pipelineManifest.upsert({
      where: { id: PIPELINE_ID },
      create: {
        id: PIPELINE_ID,
        tenantId: TENANT_ID,
        version: 1,
        status: 'APPROVED',
        ingestionManifestId: ingestion.id,
        retrievalManifestId: retrieval.id,
        answerManifestId: answer.id,
        compatibilityHash: compatibilityHashOf({
          ingestion: contentHashOf(ingestionContent),
          retrieval: contentHashOf(retrievalContent),
          answer: contentHashOf(answerContent),
        }),
        contentHash: contentHashOf({
          kind: 'pipeline',
          tenantId: TENANT_ID,
          version: 1,
          ingestionManifestId: ingestion.id,
          retrievalManifestId: retrieval.id,
          answerManifestId: answer.id,
        }),
        approvedAt: new Date(),
      },
      update: {},
    })

    await prisma.indexPartition.upsert({
      where: { id: PARTITION_ID },
      create: {
        id: PARTITION_ID,
        tenantId: TENANT_ID,
        knowledgeSpaceId: SPACE_ID,
        dataClass: 'INTERNAL',
        indexSchemaVersion: ingestionContent.indexSchemaRef,
        embeddingVersion: ingestionContent.embeddingRef,
      },
      update: {},
    })

    console.warn(
      '[seed] T1a 开发种子完成：租户 local-dev、知识空间 default、三份 APPROVED Manifest、一个 APPROVED Pipeline、一个 IndexPartition',
    )
  } finally {
    await prisma.$disconnect()
  }
}

seed().catch((error: unknown) => {
  console.error('[seed] 失败：', error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
