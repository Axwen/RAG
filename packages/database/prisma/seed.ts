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
import { loadKeycloakEndpoint } from '@rag/config'
import { createPrismaClient } from '../src/client'

/**
 * T1a 开发种子（幂等；init-database.sh 会在迁移后调用）。
 *
 * 口径（工程评审闭合记录 §4.2 / PROBE-005）：
 * - `rerankInputSize` 显式写 64（RERANK_INPUT_SIZE_SEED），不从环境变量读取；
 *   正式值由 T6 在真实业务语料上比较后拍板。
 * - `candidateBudget` 使用 ADR-0035 冻结值 1024。
 * - 种子实体使用固定 UUID，重复执行 upsert 不产生重复行。
 *
 * T12a/T11a 刻意不加种子行，不是漏了：`model_budget_ledger` 一行是「钱花掉了」的事实，
 * 种一条 SETTLED 就会吃掉开发库当日/当月预算窗口；`domain_audit_event` 一行是领域判定
 * 的事实且设计上不可删，种进去就是每个开发库里一条永久的假事实。两张表的行只应由
 * 事务入口在真实调用路径上产生。
 */

// 固定种子 ID：幂等键。只用于本地开发种子，不进入运行时代码路径。
const TENANT_ID = '018f0000-0000-7000-8000-000000000001'
const SPACE_ID = '018f0000-0000-7000-8000-000000000010'
const INGESTION_ID = '018f0000-0000-7000-8000-000000000030'
const RETRIEVAL_ID = '018f0000-0000-7000-8000-000000000031'
const ANSWER_ID = '018f0000-0000-7000-8000-000000000032'
const PIPELINE_ID = '018f0000-0000-7000-8000-000000000033'
const PARTITION_ID = '018f0000-0000-7000-8000-000000000020'

// ─── T14a 业务身份种子（ADR-0039）───────────────────────────────────
// issuer 从 KEYCLOAK_BASE_URL/KEYCLOAK_REALM 推导（loadRootEnv 已在 seed() 开头
// 载入 .env）——与 auth 模块 parseAuthConfig 的推导同一条规则，两边都不硬编码端口：
// 本机 KEYCLOAK_PORT 可能是 8081 而不是默认 8080，种子写死任何一侧都会让
// (issuer, subject) 映射键对不上。subject 与 init-keycloak.sh 的 DEV_USER_ID
// 同源，改动时两边一起改。
function identityIssuer(): string {
  const { keycloakBaseUrl, keycloakRealm } = loadKeycloakEndpoint(process.env)
  return `${keycloakBaseUrl.replace(/\/+$/, '')}/realms/${keycloakRealm}`
}
const DEV_USER_SUBJECT = '018f0000-0000-7000-8000-00000000a001'
const BUSINESS_USER_ID = '018f0000-0000-7000-8000-0000000000a1'
const TENANT_ADMIN_ROLE_ID = '018f0000-0000-7000-8000-0000000000a2'
const AGENT_ROLE_ID = '018f0000-0000-7000-8000-0000000000a3'
const ENGINEER_ROLE_ID = '018f0000-0000-7000-8000-0000000000a4'
const STAFF_ROLE_ID = '018f0000-0000-7000-8000-0000000000a5'
const AGENT_DESK_ID = '018f0000-0000-7000-8000-0000000000a6'
const ENG_DESK_ID = '018f0000-0000-7000-8000-0000000000a7'
const STAFF_DESK_ID = '018f0000-0000-7000-8000-0000000000a8'

/**
 * 能力权限码的初始目录。T14b 统一授权入口消费这些码；新增码走种子增量，
 * 不改已发布码的含义（能力码是稳定契约，改名等于新码）。
 */
const PERMISSION_CATALOG: ReadonlyArray<{ id: string; code: string; name: string }> = [
  {
    id: '018f0000-0000-7000-8000-0000000000b1',
    code: 'document.upload',
    name: '上传文档与提交候选',
  },
  {
    id: '018f0000-0000-7000-8000-0000000000b2',
    code: 'document.review',
    name: '审核候选与批准 Manifest',
  },
  { id: '018f0000-0000-7000-8000-0000000000b3', code: 'answer.run', name: '发起检索与回答' },
  { id: '018f0000-0000-7000-8000-0000000000b4', code: 'release.approve', name: '批准 Release' },
  {
    id: '018f0000-0000-7000-8000-0000000000b5',
    code: 'admin.users.manage',
    name: '管理业务用户与成员关系',
  },
]

/** dev 用户跨三个 Workspace 承担不同角色（ADR-0039 决策 3 的多 Workspace 事实）。 */
const DEV_WORKSPACE_MEMBERSHIPS: ReadonlyArray<{
  workspaceId: string
  slug: string
  name: string
  roleId: string
}> = [
  { workspaceId: AGENT_DESK_ID, slug: 'agent-desk', name: '客服工作台', roleId: AGENT_ROLE_ID },
  { workspaceId: ENG_DESK_ID, slug: 'eng-desk', name: '研发工作台', roleId: ENGINEER_ROLE_ID },
  { workspaceId: STAFF_DESK_ID, slug: 'staff-desk', name: '员工工作台', roleId: STAFF_ROLE_ID },
]

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

    // ─── T14a 业务身份（ADR-0039）───────────────────────────────────
    // 全部 upsert 幂等；dev 用户的多 Workspace 成员关系展示「同一主体在不同
    // Workspace 不同角色」，供 HG-01a 验收时看真实链路与表结构。
    for (const permission of PERMISSION_CATALOG) {
      await prisma.permission.upsert({
        where: { id: permission.id },
        create: permission,
        update: {},
      })
    }

    const roleSeeds: ReadonlyArray<{
      id: string
      scope: 'TENANT' | 'WORKSPACE'
      code: string
      name: string
      permissionIds: readonly string[]
    }> = [
      {
        id: TENANT_ADMIN_ROLE_ID,
        scope: 'TENANT',
        code: 'tenant-admin',
        name: '租户管理员',
        permissionIds: PERMISSION_CATALOG.map((p) => p.id),
      },
      {
        id: AGENT_ROLE_ID,
        scope: 'WORKSPACE',
        code: 'agent',
        name: '客服',
        permissionIds: [
          PERMISSION_CATALOG[2]!.id, // answer.run
        ],
      },
      {
        id: ENGINEER_ROLE_ID,
        scope: 'WORKSPACE',
        code: 'engineer',
        name: '研发',
        permissionIds: [
          PERMISSION_CATALOG[0]!.id, // document.upload
          PERMISSION_CATALOG[2]!.id, // answer.run
        ],
      },
      {
        id: STAFF_ROLE_ID,
        scope: 'WORKSPACE',
        code: 'staff',
        name: '普通员工',
        permissionIds: [
          PERMISSION_CATALOG[2]!.id, // answer.run
        ],
      },
    ]
    for (const role of roleSeeds) {
      await prisma.role.upsert({
        where: { id: role.id },
        create: {
          id: role.id,
          tenantId: TENANT_ID,
          scope: role.scope,
          code: role.code,
          name: role.name,
        },
        update: {},
      })
      for (const permissionId of role.permissionIds) {
        await prisma.rolePermission.upsert({
          where: { roleId_permissionId: { roleId: role.id, permissionId } },
          create: { roleId: role.id, permissionId },
          update: {},
        })
      }
    }

    await prisma.businessUser.upsert({
      where: { id: BUSINESS_USER_ID },
      create: {
        id: BUSINESS_USER_ID,
        issuer: identityIssuer(),
        subject: DEV_USER_SUBJECT,
        displayName: 'Dev User',
        email: 'dev@example.invalid',
      },
      update: {
        // 固定 dev 用户必须随 KEYCLOAK_BASE_URL/KEYCLOAK_REALM 变化自愈，否则
        // 重建 realm 后 token 的 issuer 变化会让 (issuer, subject) 映射失效。
        issuer: identityIssuer(),
        subject: DEV_USER_SUBJECT,
      },
    })

    await prisma.tenantMembership.upsert({
      where: { tenantId_businessUserId: { tenantId: TENANT_ID, businessUserId: BUSINESS_USER_ID } },
      create: {
        tenantId: TENANT_ID,
        businessUserId: BUSINESS_USER_ID,
        tenantRoleId: TENANT_ADMIN_ROLE_ID,
      },
      update: {},
    })

    for (const desk of DEV_WORKSPACE_MEMBERSHIPS) {
      await prisma.workspace.upsert({
        where: { id: desk.workspaceId },
        create: {
          id: desk.workspaceId,
          tenantId: TENANT_ID,
          slug: desk.slug,
          name: desk.name,
        },
        update: {},
      })
      await prisma.workspaceMembership.upsert({
        where: {
          workspaceId_businessUserId: {
            workspaceId: desk.workspaceId,
            businessUserId: BUSINESS_USER_ID,
          },
        },
        create: {
          tenantId: TENANT_ID,
          workspaceId: desk.workspaceId,
          businessUserId: BUSINESS_USER_ID,
          roleId: desk.roleId,
        },
        update: {},
      })
    }

    console.warn(
      '[seed] T1a 开发种子完成：租户 local-dev、知识空间 default、三份 APPROVED Manifest、一个 APPROVED Pipeline、一个 IndexPartition',
    )
    console.warn(
      '[seed] T14a 身份种子完成：BusinessUser dev、租户管理员、三个 Workspace（客服/研发/员工）与能力权限码初始目录',
    )
  } finally {
    await prisma.$disconnect()
  }
}

seed().catch((error: unknown) => {
  console.error('[seed] 失败：', error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
