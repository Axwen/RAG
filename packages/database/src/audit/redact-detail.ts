import { REDACTED, contentFieldNames, secretFieldNames } from '@rag/observability'

/**
 * 审计 `detail` 的强制脱敏（T11a 不变量）。
 *
 * 审计行不可变、且不随业务数据删除而删除（ADR-0040 决策 5）。这两条只有在 `detail`
 * 不落正文时才成立——一旦把 Prompt 或文档正文写进去，「永久保留」就变成了「永久保留
 * 客户正文」，删除证明也就说不清了。所以脱敏在写库前强制执行，不是调用方的自觉。
 *
 * 复用 `packages/observability/src/redaction.ts` 的两张字段名表（`contentFieldNames`
 * 与 `secretFieldNames`）与占位符 `REDACTED`：**只复用字段名清单与常量，不 import 任何
 * 遥测导出器**（T11a 不变量：审计与遥测在包依赖图上互相看不见）。占位符共用同一个字面量
 * 是有意的：日志里查 `[REDACTED]` 与审计里查到的是同一个标记。
 */

/**
 * 比对时同时忽略大小写与 `_`/`-` 分隔：`apiKey`、`apikey`、`API_KEY`、`api-key` 归一到同一个键。
 *
 * 比 `@rag/observability` 的清单契约（那里只承诺「大小写不敏感匹配由调用方保证」）更严一档，
 * 是因为两边的代价不对称：日志会滚掉，审计行不可变且不随业务数据删除而删除，一次漏脱敏就是
 * 一条永久留在库里的正文。审计 detail 的键来自各个域的判定现场，snake_case 与 SCREAMING_CASE
 * 都会出现。
 */
function normalizeFieldName(name: string): string {
  return name.toLowerCase().replaceAll('_', '').replaceAll('-', '')
}

const redactedFieldNames: ReadonlySet<string> = new Set(
  [...secretFieldNames, ...contentFieldNames].map(normalizeFieldName),
)

/**
 * 递归深度上限。
 *
 * 不是防御性编程凑数：`detail` 是 JSONB，深层嵌套既没有读侧价值，又让脱敏的正确性
 * 依赖于「每一层都走到了」。超过就抛——审计宁可写不进去让业务回滚，也不能写进一个
 * 只脱敏了前几层的对象。
 */
const maxDepth = 8

/** JSON 里没有对应表示的三种值。留着会让 Prisma 在写 JSONB 时抛一个看不出出处的错。 */
function isJsonDroppable(value: unknown): boolean {
  return value === undefined || typeof value === 'function' || typeof value === 'symbol'
}

function redactValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (depth > maxDepth) {
    throw new Error(`审计 detail 嵌套超过 ${maxDepth} 层：脱敏无法保证逐层生效，请先在调用侧摊平`)
  }
  if (value === null || typeof value !== 'object') {
    // bigint 不能进 JSON，转字符串而不是让 Prisma 在写库时抛一个看不出出处的错。
    return typeof value === 'bigint' ? value.toString() : value
  }
  if (seen.has(value)) {
    throw new Error('审计 detail 存在循环引用：无法序列化为 JSONB')
  }
  const toJson = (value as { toJSON?: unknown }).toJSON
  if (typeof toJson === 'function') {
    // Date -> ISO 字符串、Prisma.Decimal -> 数字字符串。不走这一步就会递归进 Decimal
    // 的内部字段（s/e/d），审计里留下一堆没人看得懂的数组。
    return redactValue((toJson as () => unknown).call(value), depth, seen)
  }
  seen.add(value)
  try {
    if (Array.isArray(value)) {
      // 数组里的 undefined/函数/symbol 按 JSON 语义变 null（不能像对象那样丢键，
      // 丢键会让下标错位，审计里「第 3 个候选」就指向了别的东西）。
      return value.map((item) => {
        const redacted = redactValue(item, depth + 1, seen)
        return isJsonDroppable(redacted) ? null : redacted
      })
    }
    const output: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) {
      if (redactedFieldNames.has(normalizeFieldName(key))) {
        output[key] = REDACTED
        continue
      }
      // undefined 与函数按 JSON 语义丢键，而不是写成 null：审计里的 null 应当表示
      // 「判定时确实没有这个值」，不该和「调用方传了个函数」混在一起。
      const redacted = redactValue(item, depth + 1, seen)
      if (!isJsonDroppable(redacted)) {
        output[key] = redacted
      }
    }
    return output
  } finally {
    seen.delete(value)
  }
}

/** 脱敏一层 `detail`。键名命中两张表即整体替换为 `[REDACTED]`，值不做部分保留。 */
export function redactAuditDetail(detail: Record<string, unknown>): Record<string, unknown> {
  return redactValue(detail, 1, new WeakSet()) as Record<string, unknown>
}
