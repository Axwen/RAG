import { Body, Controller, Get, HttpCode, Param, Post, Req, UseGuards } from '@nestjs/common'
import type { Request } from 'express'
import { ApiErrorException } from '../common/api-error.exception'
import { ManifestsService } from './manifests.service'
import { IdentityGuard, identityOf } from '../auth/identity.guard'
import { AuthorizationService } from '../authorization/authorization.service'
import {
  answerManifestCreateSchema,
  ingestionManifestCreateSchema,
  pipelineManifestCreateSchema,
  releaseManifestCreateSchema,
  retrievalManifestCreateSchema,
} from './manifests.schemas'

/**
 * Manifest 与 Release 端点（T1a；T14b 起受身份守卫保护）。
 *
 * 租户上下文只从服务端身份推导（IdentityGuard → request.identity），
 * 请求体的 tenantId 已退场并被忽略（T14 DoD 的迁移期兼容退场）。
 */
@Controller()
@UseGuards(IdentityGuard)
export class ManifestsController {
  constructor(
    private readonly manifests: ManifestsService,
    private readonly authorization: AuthorizationService,
  ) {}

  private async requireCapability(request: Request, capability: string) {
    const identity = identityOf(request)
    const decision = await this.authorization.authorize({
      businessUserId: identity.context.businessUserId,
      tenantId: identity.tenantId,
      capability,
    })
    if (decision.allowed) return identity
    if (decision.reason === 'DEPENDENCY_UNAVAILABLE') {
      throw new ApiErrorException('DEPENDENCY_UNAVAILABLE', '授权服务暂不可用，请稍后重试')
    }
    throw new ApiErrorException('FORBIDDEN', '当前身份没有执行此操作的权限')
  }

  @Post('manifests/ingestion')
  @HttpCode(201)
  async createIngestion(@Req() req: Request, @Body() body: unknown) {
    const identity = await this.requireCapability(req, 'document.review')
    return this.manifests.createIngestion(
      identity.tenantId,
      ingestionManifestCreateSchema.parse(body),
    )
  }

  @Post('manifests/ingestion/:id/approve')
  @HttpCode(200)
  async approveIngestion(@Req() req: Request, @Param('id') id: string) {
    const identity = await this.requireCapability(req, 'document.review')
    return this.manifests.approveIngestion(identity.tenantId, id)
  }

  @Post('manifests/retrieval')
  @HttpCode(201)
  async createRetrieval(@Req() req: Request, @Body() body: unknown) {
    const identity = await this.requireCapability(req, 'document.review')
    return this.manifests.createRetrieval(
      identity.tenantId,
      retrievalManifestCreateSchema.parse(body),
    )
  }

  @Post('manifests/retrieval/:id/approve')
  @HttpCode(200)
  async approveRetrieval(@Req() req: Request, @Param('id') id: string) {
    const identity = await this.requireCapability(req, 'document.review')
    return this.manifests.approveRetrieval(identity.tenantId, id)
  }

  @Post('manifests/answer')
  @HttpCode(201)
  async createAnswer(@Req() req: Request, @Body() body: unknown) {
    const identity = await this.requireCapability(req, 'document.review')
    return this.manifests.createAnswer(identity.tenantId, answerManifestCreateSchema.parse(body))
  }

  @Post('manifests/answer/:id/approve')
  @HttpCode(200)
  async approveAnswer(@Req() req: Request, @Param('id') id: string) {
    const identity = await this.requireCapability(req, 'document.review')
    return this.manifests.approveAnswer(identity.tenantId, id)
  }

  @Post('manifests/pipelines')
  @HttpCode(201)
  async createPipeline(@Req() req: Request, @Body() body: unknown) {
    const identity = await this.requireCapability(req, 'document.review')
    return this.manifests.createPipeline(
      identity.tenantId,
      pipelineManifestCreateSchema.parse(body),
    )
  }

  @Post('manifests/pipelines/:id/approve')
  @HttpCode(200)
  async approvePipeline(@Req() req: Request, @Param('id') id: string) {
    const identity = await this.requireCapability(req, 'document.review')
    return this.manifests.approvePipeline(identity.tenantId, id)
  }

  @Post('releases')
  @HttpCode(201)
  async createRelease(@Req() req: Request, @Body() body: unknown) {
    const identity = await this.requireCapability(req, 'release.approve')
    return this.manifests.createRelease(identity.tenantId, releaseManifestCreateSchema.parse(body))
  }

  @Get('releases/:id')
  async findRelease(@Req() req: Request, @Param('id') id: string) {
    const identity = await this.requireCapability(req, 'release.approve')
    const found = await this.manifests.findRelease(identity.tenantId, id)
    if (found === null) {
      throw new ApiErrorException('NOT_FOUND', 'ReleaseManifest 不存在', { param: 'id' })
    }
    return found
  }
}
