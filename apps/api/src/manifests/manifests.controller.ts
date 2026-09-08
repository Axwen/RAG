import { Body, Controller, Get, HttpCode, Param, Post, Req, UseGuards } from '@nestjs/common'
import type { Request } from 'express'
import { ManifestsService } from './manifests.service'
import { IdentityGuard, identityOf } from '../auth/identity.guard'
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
  constructor(private readonly manifests: ManifestsService) {}

  @Post('manifests/ingestion')
  @HttpCode(201)
  createIngestion(@Req() req: Request, @Body() body: unknown) {
    return this.manifests.createIngestion(
      identityOf(req).tenantId,
      ingestionManifestCreateSchema.parse(body),
    )
  }

  @Post('manifests/ingestion/:id/approve')
  @HttpCode(200)
  approveIngestion(@Req() req: Request, @Param('id') id: string) {
    return this.manifests.approveIngestion(identityOf(req).tenantId, id)
  }

  @Post('manifests/retrieval')
  @HttpCode(201)
  createRetrieval(@Req() req: Request, @Body() body: unknown) {
    return this.manifests.createRetrieval(
      identityOf(req).tenantId,
      retrievalManifestCreateSchema.parse(body),
    )
  }

  @Post('manifests/retrieval/:id/approve')
  @HttpCode(200)
  approveRetrieval(@Req() req: Request, @Param('id') id: string) {
    return this.manifests.approveRetrieval(identityOf(req).tenantId, id)
  }

  @Post('manifests/answer')
  @HttpCode(201)
  createAnswer(@Req() req: Request, @Body() body: unknown) {
    return this.manifests.createAnswer(
      identityOf(req).tenantId,
      answerManifestCreateSchema.parse(body),
    )
  }

  @Post('manifests/answer/:id/approve')
  @HttpCode(200)
  approveAnswer(@Req() req: Request, @Param('id') id: string) {
    return this.manifests.approveAnswer(identityOf(req).tenantId, id)
  }

  @Post('manifests/pipelines')
  @HttpCode(201)
  createPipeline(@Req() req: Request, @Body() body: unknown) {
    return this.manifests.createPipeline(
      identityOf(req).tenantId,
      pipelineManifestCreateSchema.parse(body),
    )
  }

  @Post('manifests/pipelines/:id/approve')
  @HttpCode(200)
  approvePipeline(@Req() req: Request, @Param('id') id: string) {
    return this.manifests.approvePipeline(identityOf(req).tenantId, id)
  }

  @Post('releases')
  @HttpCode(201)
  createRelease(@Req() req: Request, @Body() body: unknown) {
    return this.manifests.createRelease(
      identityOf(req).tenantId,
      releaseManifestCreateSchema.parse(body),
    )
  }

  @Get('releases/:id')
  findRelease(@Req() req: Request, @Param('id') id: string) {
    return this.manifests.findRelease(identityOf(req).tenantId, id)
  }
}
