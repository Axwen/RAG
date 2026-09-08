import type { Tx } from '../tx'

/**
 * 递增租户的授权事实版本（T14b / ADR-0026）。
 *
 * 撤权、成员变更、（未来的）知识空间可见性变更都必须在同一个事务里调用：
 * revision 递增让 Redis「主体→允许作用域」缓存立即失效，不依赖 TTL。
 * 只接受已开启的 `tx`——「改成员关系却不递增 revision」必须让整个事务
 * 回滚，不允许分开提交（与审计写入口同一条纪律）。
 *
 * 阶段 1 尚无成员写路径（管理面归 T16b），调用方是集成测试与未来的
 * 管理入口；正因如此更要把不变量钉在入口上，而不是靠每个调用方记得。
 */
export async function bumpAclRevision(tx: Tx, tenantId: string): Promise<number> {
  const tenant = await tx.tenant.update({
    where: { id: tenantId },
    data: { aclRevision: { increment: 1 } },
    select: { aclRevision: true },
  })
  return tenant.aclRevision
}
