import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * PKCE（RFC 7636，S256）：Authorization Code 流的客户端证明。
 *
 * login 生成 (verifier, challenge) 并把 verifier 藏在临时 cookie 里；
 * callback 用同一 verifier 换 token——authorization code 拦截者没有 verifier，
 * 换不到 token。challenge = BASE64URL(SHA256(verifier))。
 *
 * state 同批生成：回调时比对，挡 CSRF 的授权码注入。
 */

const VERIFIER_BYTES = 32 // RFC 7636 §4.1：43–128 字符（base64url 后 43 字符起）
const STATE_BYTES = 16

function base64Url(bytes: Buffer): string {
  return bytes.toString('base64url')
}

export interface PkcePair {
  readonly verifier: string
  readonly challenge: string
}

export function createPkcePair(): PkcePair {
  const verifier = base64Url(randomBytes(VERIFIER_BYTES))
  const challenge = base64Url(createHash('sha256').update(verifier).digest())
  return { verifier, challenge }
}

export function createState(): string {
  return base64Url(randomBytes(STATE_BYTES))
}

/** 恒定时间比对：state 回调校验，不做早退比较。 */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}
