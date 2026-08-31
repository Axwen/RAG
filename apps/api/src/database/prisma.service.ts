import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '@rag/database'
import { requireDatabaseUrl } from '@rag/database'

/**
 * NestJS 生命周期内的 PrismaClient 持有者。
 *
 * 连接串在实例化时解析：缺失即让应用启动失败，而不是等到第一个请求。
 * 关闭钩子负责断开，避免 Worker/Compose 往返时的悬挂连接。
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor() {
    super({ adapter: new PrismaPg({ connectionString: requireDatabaseUrl() }) })
  }

  async onModuleInit(): Promise<void> {
    await this.$connect()
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect()
  }
}
