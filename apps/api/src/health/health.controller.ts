import { Controller, Get, HttpStatus, Res } from '@nestjs/common'
import type { Response } from 'express'
import { HealthService } from './health.service'

@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get('live')
  live(): { status: 'ok'; service: string } {
    return this.health.live()
  }

  @Get('ready')
  async ready(@Res() res: Response): Promise<void> {
    const report = await this.health.ready()
    const status = report.status === 'up' ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE
    res.status(status).json(report)
  }
}
