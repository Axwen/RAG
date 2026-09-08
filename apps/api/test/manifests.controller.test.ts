import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Request } from 'express'
import type { ServerIdentityContext } from '@rag/contracts'
import type { AuthorizationService } from '../src/authorization/authorization.service'
import { ManifestsController } from '../src/manifests/manifests.controller'
import type { ManifestsService } from '../src/manifests/manifests.service'

const TENANT_ID = '018f0000-0000-7000-8000-000000000001'
const BUSINESS_USER_ID = '018f0000-0000-7000-8000-0000000000a1'
const RESOURCE_ID = '018f0000-0000-7000-8000-000000000010'

const context: ServerIdentityContext = {
  businessUserId: BUSINESS_USER_ID,
  issuer: 'https://identity.example/realms/rag',
  subject: 'subject-1',
  displayName: 'Reviewer',
  email: null,
  userStatus: 'ACTIVE',
  tenantMemberships: [{ tenantId: TENANT_ID, status: 'ACTIVE', tenantRole: null }],
  workspaceMemberships: [],
}

const request = {
  identity: { context, tenantId: TENANT_ID },
} as unknown as Request

const ingestionBody = {
  version: 1,
  parserRef: 'parser@1',
  chunkerRef: 'chunker@1',
  embeddingRef: 'embedding@1',
  indexSchemaRef: 'schema@1',
  sourceFormats: ['pdf'],
}

const retrievalBody = {
  version: 1,
  sparsePolicy: {},
  vectorPolicy: {
    channels: [{ name: 'main', embeddingRef: 'embedding@1', dimension: 1024 }],
  },
  fusionPolicy: {},
  rerankerRef: 'reranker@1',
  candidateBudget: 1024,
}

const answerBody = {
  version: 1,
  promptRef: 'prompt@1',
  modelRouteRef: 'model@1',
  citationPolicy: {},
  riskPolicy: {},
  fallbackPolicy: {},
}

const pipelineBody = {
  version: 1,
  ingestionManifestId: RESOURCE_ID,
  retrievalManifestId: RESOURCE_ID,
  answerManifestId: RESOURCE_ID,
}

const releaseBody = {
  knowledgeSpaceId: RESOURCE_ID,
  indexPartitionId: RESOURCE_ID,
  ingestionManifestId: RESOURCE_ID,
  memberSetUri: 's3://bucket/member-set.json',
  memberSetHash: 'sha256:member-set',
  memberCount: 1,
  docIndexName: 'docs-v1',
  chunkIndexName: 'chunks-v1',
  candidateAlias: 'candidate-v1',
}

function makeController() {
  const manifests = {
    createIngestion: vi.fn().mockResolvedValue({ id: RESOURCE_ID }),
    approveIngestion: vi.fn().mockResolvedValue({ id: RESOURCE_ID }),
    createRetrieval: vi.fn().mockResolvedValue({ id: RESOURCE_ID }),
    approveRetrieval: vi.fn().mockResolvedValue({ id: RESOURCE_ID }),
    createAnswer: vi.fn().mockResolvedValue({ id: RESOURCE_ID }),
    approveAnswer: vi.fn().mockResolvedValue({ id: RESOURCE_ID }),
    createPipeline: vi.fn().mockResolvedValue({ id: RESOURCE_ID }),
    approvePipeline: vi.fn().mockResolvedValue({ id: RESOURCE_ID }),
    createRelease: vi.fn().mockResolvedValue({ id: RESOURCE_ID }),
    findRelease: vi.fn().mockResolvedValue({ id: RESOURCE_ID }),
  }
  const authorization = {
    authorize: vi.fn().mockResolvedValue({ allowed: true }),
  }
  const controller = new ManifestsController(
    manifests as unknown as ManifestsService,
    authorization as unknown as AuthorizationService,
  )
  return { controller, manifests, authorization }
}

const documentOperations = [
  [
    'createIngestion',
    (controller: ManifestsController) => controller.createIngestion(request, ingestionBody),
  ],
  [
    'approveIngestion',
    (controller: ManifestsController) => controller.approveIngestion(request, RESOURCE_ID),
  ],
  [
    'createRetrieval',
    (controller: ManifestsController) => controller.createRetrieval(request, retrievalBody),
  ],
  [
    'approveRetrieval',
    (controller: ManifestsController) => controller.approveRetrieval(request, RESOURCE_ID),
  ],
  [
    'createAnswer',
    (controller: ManifestsController) => controller.createAnswer(request, answerBody),
  ],
  [
    'approveAnswer',
    (controller: ManifestsController) => controller.approveAnswer(request, RESOURCE_ID),
  ],
  [
    'createPipeline',
    (controller: ManifestsController) => controller.createPipeline(request, pipelineBody),
  ],
  [
    'approvePipeline',
    (controller: ManifestsController) => controller.approvePipeline(request, RESOURCE_ID),
  ],
] as const

const releaseOperations = [
  [
    'createRelease',
    (controller: ManifestsController) => controller.createRelease(request, releaseBody),
  ],
  [
    'findRelease',
    (controller: ManifestsController) => controller.findRelease(request, RESOURCE_ID),
  ],
] as const

beforeEach(() => {
  vi.clearAllMocks()
})

describe('ManifestsController 统一授权入口', () => {
  it.each(documentOperations)('%s 在领域调用前要求 document.review', async (method, run) => {
    const { controller, manifests, authorization } = makeController()
    await run(controller)
    expect(authorization.authorize).toHaveBeenCalledWith({
      businessUserId: BUSINESS_USER_ID,
      tenantId: TENANT_ID,
      capability: 'document.review',
    })
    expect(authorization.authorize.mock.invocationCallOrder[0]).toBeLessThan(
      manifests[method].mock.invocationCallOrder[0]!,
    )
  })

  it.each(releaseOperations)('%s 在领域调用前要求 release.approve', async (method, run) => {
    const { controller, manifests, authorization } = makeController()
    await run(controller)
    expect(authorization.authorize).toHaveBeenCalledWith({
      businessUserId: BUSINESS_USER_ID,
      tenantId: TENANT_ID,
      capability: 'release.approve',
    })
    expect(authorization.authorize.mock.invocationCallOrder[0]).toBeLessThan(
      manifests[method].mock.invocationCallOrder[0]!,
    )
  })

  it.each([
    ['CAPABILITY_MISSING', 'FORBIDDEN'],
    ['SCOPE_DENIED', 'FORBIDDEN'],
    ['DATA_CLASS_DENIED', 'FORBIDDEN'],
    ['DEPENDENCY_UNAVAILABLE', 'DEPENDENCY_UNAVAILABLE'],
  ] as const)('%s 拒绝时不调用领域服务并映射 %s', async (reason, expectedCode) => {
    const { controller, manifests, authorization } = makeController()
    authorization.authorize.mockResolvedValue({ allowed: false, reason })

    await expect(controller.createIngestion(request, ingestionBody)).rejects.toMatchObject({
      envelope: { code: expectedCode },
    })
    expect(manifests.createIngestion).not.toHaveBeenCalled()
  })
})
