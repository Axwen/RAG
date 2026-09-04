/**
 * 日志脱敏默认值。
 *
 * 约束来自 ADR-0032（文档内容永远是数据，不是指令）与阶段 1 数据分级：
 * 凭证、鉴权头、模型密钥、Prompt 正文、文档正文与检索命中片段都不得进入日志。
 * 这里只提供默认 redact 路径与工具函数；按票据加入新字段时必须同步扩充。
 */

/** 需要整体替换为占位符的字段名（大小写不敏感匹配由调用方保证）。 */
export const secretFieldNames = [
  'password',
  'passwd',
  'secret',
  'token',
  'accessToken',
  'refreshToken',
  'idToken',
  'clientSecret',
  'apiKey',
  'apikey',
  'authorization',
  'cookie',
  'setCookie',
] as const

/**
 * 需要脱敏的内容字段名。
 *
 * 这些字段承载文档正文、Prompt、模型输出或检索片段。它们可能包含注入载荷或
 * 客户敏感信息，一律不落日志；需要排查时使用对象存储快照与 runId 关联。
 */
export const contentFieldNames = [
  'prompt',
  'messages',
  'input',
  'inputs',
  'instructions',
  'documentText',
  'chunkText',
  // 检索命中片段的常见键名。docblock 里「检索命中片段」这一条原先在清单里没有落点，
  // 而它正是审计 detail 最容易夹带正文的地方（EVIDENCE/INJECTION 两个域的判定详情）。
  'snippet',
  'snippets',
  'text',
  'content',
  'answer',
  'draft',
  'query',
  'reasoningContent',
  'embedding',
  'embeddings',
] as const

const redactPathsFor = (names: readonly string[]): string[] =>
  names.flatMap((name) => [
    name,
    `*.${name}`,
    `*.*.${name}`,
    `req.headers.${name}`,
    `res.headers.${name}`,
  ])

/** pino `redact.paths` 默认值。 */
export const defaultRedactPaths: string[] = [
  ...redactPathsFor(secretFieldNames),
  ...redactPathsFor(contentFieldNames),
]

/** 脱敏占位符。固定字面量，便于日志检索时确认脱敏确实生效。 */
export const REDACTED = '[REDACTED]' as const
