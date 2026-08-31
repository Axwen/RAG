import { Global, Module } from '@nestjs/common'
import { PrismaService } from './prisma.service'

/**
 * 全局 Prisma 模块：领域模块直接注入 PrismaService，不重复建连接。
 */
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
