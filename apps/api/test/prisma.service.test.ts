import { afterEach, describe, expect, it, vi } from 'vitest'
import { PrismaService } from '../src/database/prisma.service'

/**
 * PrismaService 只有三个成员，但每一个都是"错了不会报错、只会静默失效"的那类代码：
 * 构造时解析连接串（缺失必须让应用启动失败，而不是等到第一个请求），
 * 两个生命周期钩子负责建连与断连（钩子名写错、或漏掉 implements，NestJS 不会报错，
 * 表现是连接泄漏或首个请求才连库）。
 *
 * 不触真库：连接串指向没有监听的端口，$connect / $disconnect 以 spy 拦下。
 * pg 连接池是懒建立的，构造本身不发起网络请求。
 *
 * 这个文件同时是一次覆盖率盲点的修复：vite 7 的 TS 转译会把
 * `manifests.service.ts` 里只出现在参数类型位置的 `import { PrismaService }` 整个消掉，
 * 于是该模块在测试运行里从未被加载过——而 vitest 4 默认只报告"被加载过"的文件，
 * 本文件因此完全不在覆盖率报告里（不是 0%，是没有这一行）。vite 8 保留了这个 import，
 * 盲点随之现形：functions 分母 101 → 104，三个函数一个都没测。
 */

/** 指向没有监听的端口：形态合法、连不上，确保任何真实往返都会失败而不是悄悄成功。 */
const unreachableUrl = 'postgresql://rag:pw@127.0.0.1:1/rag?schema=public'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('PrismaService', () => {
  it('缺少 DATABASE_URL 时构造即失败', () => {
    vi.stubEnv('DATABASE_URL', '')
    expect(() => new PrismaService()).toThrow(/DATABASE_URL/)
  })

  it('onModuleInit 建连、onModuleDestroy 断连', async () => {
    vi.stubEnv('DATABASE_URL', unreachableUrl)
    const service = new PrismaService()
    const connect = vi.spyOn(service, '$connect').mockResolvedValue(undefined)
    const disconnect = vi.spyOn(service, '$disconnect').mockResolvedValue(undefined)

    await service.onModuleInit()
    expect(connect).toHaveBeenCalledTimes(1)
    expect(disconnect).not.toHaveBeenCalled()

    await service.onModuleDestroy()
    expect(disconnect).toHaveBeenCalledTimes(1)
  })
})
