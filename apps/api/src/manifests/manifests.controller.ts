import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common'
import { ApiErrorException } from '../common/api-error.exception'
import { ManifestsService } from './manifests.service'
import {
  answerManifestCreateSchema,
  ingestionManifestCreateSchema,
  pipelineManifestCreateSchema,
  releaseManifestCreateSchema,
  retrievalManifestCreateSchema,
} from './manifests.schemas'

/**
 * Manifest 与 Release 端点（T1a）。
 *
 * tenantId 暂由请求体显式携带；T14 身份与授权落地后改为服务端身份上下文
 * 注入，届时本控制器只改参数来源，契约不变。
 */
@Controller()
export class ManifestsController {
  constructor(private readonly manifests: ManifestsService) {}

  @Post('manifests/ingestion')
  @HttpCode(201)
  createIngestion(@Body() body: unknown) {
    return this.manifests.createIngestion(ingestionManifestCreateSchema.parse(body))
  }

  @Post('manifests/ingestion/:id/approve')
  @HttpCode(200)
  approveIngestion(@Param('id') id: string) {
    return this.manifests.approveIngestion(id)
  }

  @Post('manifests/retrieval')
  @HttpCode(201)
  createRetrieval(@Body() body: unknown) {
    return this.manifests.createRetrieval(retrievalManifestCreateSchema.parse(body))
  }

  @Post('manifests/retrieval/:id/approve')
  @HttpCode(200)
  approveRetrieval(@Param('id') id: string) {
    return this.manifests.approveRetrieval(id)
  }

  @Post('manifests/answer')
  @HttpCode(201)
  createAnswer(@Body() body: unknown) {
    return this.manifests.createAnswer(answerManifestCreateSchema.parse(body))
  }

  @Post('manifests/answer/:id/approve')
  @HttpCode(200)
  approveAnswer(@Param('id') id: string) {
    return this.manifests.approveAnswer(id)
  }

  @Post('manifests/pipelines')
  @HttpCode(201)
  createPipeline(@Body() body: unknown) {
    return this.manifests.createPipeline(pipelineManifestCreateSchema.parse(body))
  }

  @Post('manifests/pipelines/:id/approve')
  @HttpCode(200)
  approvePipeline(@Param('id') id: string) {
    return this.manifests.approvePipeline(id)
  }

  @Post('releases')
  @HttpCode(201)
  createRelease(@Body() body: unknown) {
    return this.manifests.createRelease(releaseManifestCreateSchema.parse(body))
  }

  @Get('releases/:id')
  async getRelease(@Param('id') id: string) {
    const found = await this.manifests.findRelease(id)
    if (found === null) {
      throw new ApiErrorException('NOT_FOUND', 'ReleaseManifest 不存在', { param: 'id' })
    }
    return found
  }
}
