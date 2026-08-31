import { createHash } from 'node:crypto'
import type { ManifestContent } from './content'

/**
 * Manifest contentHash 规范：先规范化为字段按字典序排列的 JSON（无空白），
 * 再取 SHA-256 十六进制。同一逻辑内容在任何进程、任何键序下得到同一哈希；
 * 这让 (tenantId, contentHash) 唯一约束可以直接防止重复入库。
 *
 * JSON.stringify 对普通对象按插入序序列化键，因此这里显式做一次递归排序，
 * 不依赖对象构造时的键顺序。
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`
  }
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`
}

/** 计算内容寻址哈希。任何 Manifest 字段变化都会得到不同的哈希。 */
export function contentHashOf(content: ManifestContent): string {
  return createHash('sha256').update(canonicalJson(content), 'utf8').digest('hex')
}

/**
 * PipelineManifest 的 compatibilityHash：组合内三份 Manifest 各自 contentHash
 * 的规范化哈希。组合内任何一份 Manifest 变化（即新哈希）都会产生新的
 * compatibilityHash，对应「任何引用版本变化必须新建 Pipeline」。
 */
export function compatibilityHashOf(hashes: {
  readonly ingestion: string
  readonly retrieval: string
  readonly answer: string
}): string {
  return createHash('sha256')
    .update(
      canonicalJson({
        ingestion: hashes.ingestion,
        retrieval: hashes.retrieval,
        answer: hashes.answer,
      }),
      'utf8',
    )
    .digest('hex')
}
