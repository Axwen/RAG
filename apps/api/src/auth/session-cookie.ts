import { createHmac, timingSafeEqual } from 'node:crypto'
import type { ServerIdentityContext } from '@rag/contracts'

/**
 * 会话 Cookie（T14a）：HMAC-SHA256 签名的自包含会话。
 *
 * 为什么不用服务端 session 表：7 张身份表是 ADR-0039 定下的最小模型，
 * 没有 session 表；单实例本地开发阶段，自包含 cookie + 服务端密钥即可承载
 * 「会话过期」语义。代价写在这里，不留错觉：
 * - 会话 TTL 内成员关系变更不生效（上下文在登录时装配快照）；T14b 的统一
 *   授权入口每次判定都查库，不依赖这份快照，所以授权侧不受影响。
 * - 多实例部署需要共享密钥（同一 AUTH_SESSION_SECRET）或换集中存储，届时
 *   先补票据再动结构。
 *
 * 载荷是 base64url(JSON)，不加密：内容是身份事实的投影（businessUserId、
 * 成员关系），不含 Keycloak 原始 token——token 不落 Cookie，也不落日志。
 */

export interface SessionPayload {
  readonly context: ServerIdentityContext
  /** Unix 秒。过期即失效，与 Cookie 自身的 Max-Age 双保险（见 auth.controller）。 */
  readonly expiresAt: number
}

export const SESSION_COOKIE_NAME = 'rag_session'
export const PKCE_COOKIE_NAME = 'rag_pkce'

export function signSession(payload: SessionPayload, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const mac = createHmac('sha256', secret).update(body).digest('base64url')
  return `${body}.${mac}`
}

export type SessionParseResult =
  | { readonly ok: true; readonly payload: SessionPayload }
  | { readonly ok: false; readonly reason: 'MALFORMED' | 'BAD_SIGNATURE' | 'EXPIRED' }

export function parseSessionCookie(
  cookie: string | undefined,
  secret: string,
  now: Date = new Date(),
): SessionParseResult {
  if (cookie === undefined || cookie.length === 0) return { ok: false, reason: 'MALFORMED' }
  const dot = cookie.lastIndexOf('.')
  if (dot <= 0) return { ok: false, reason: 'MALFORMED' }
  const body = cookie.slice(0, dot)
  const mac = cookie.slice(dot + 1)
  const expected = createHmac('sha256', secret).update(body).digest('base64url')
  const left = Buffer.from(mac)
  const right = Buffer.from(expected)
  if (left.length !== right.length || !timingSafeEqual(left, right)) {
    return { ok: false, reason: 'BAD_SIGNATURE' }
  }
  let payload: SessionPayload
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as SessionPayload
  } catch {
    return { ok: false, reason: 'MALFORMED' }
  }
  if (
    typeof payload.expiresAt !== 'number' ||
    Math.floor(now.getTime() / 1000) >= payload.expiresAt
  ) {
    return { ok: false, reason: 'EXPIRED' }
  }
  return { ok: true, payload }
}

/** PKCE 临时 cookie 的载荷：verifier + state，回调时一次性消费。 */
export interface PkceCookiePayload {
  readonly verifier: string
  readonly state: string
}

/**
 * 从原始 Cookie 头取单个值。不引 cookie-parser：auth 模块只读两个自有
 * cookie，request 侧的完整解析交给需要它的后续票据。
 */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (header === undefined) return undefined
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq <= 0) continue
    if (part.slice(0, eq).trim() === name) {
      return part.slice(eq + 1).trim()
    }
  }
  return undefined
}

export function signPkceCookie(payload: PkceCookiePayload, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const mac = createHmac('sha256', secret).update(body).digest('base64url')
  return `${body}.${mac}`
}

export type PkceCookieParseResult =
  | { readonly ok: true; readonly payload: PkceCookiePayload }
  | { readonly ok: false; readonly reason: 'MALFORMED' | 'BAD_SIGNATURE' }

export function parsePkceCookie(cookie: string | undefined, secret: string): PkceCookieParseResult {
  if (cookie === undefined || cookie.length === 0) return { ok: false, reason: 'MALFORMED' }
  const dot = cookie.lastIndexOf('.')
  if (dot <= 0) return { ok: false, reason: 'MALFORMED' }
  const body = cookie.slice(0, dot)
  const mac = cookie.slice(dot + 1)
  const expected = createHmac('sha256', secret).update(body).digest('base64url')
  const left = Buffer.from(mac)
  const right = Buffer.from(expected)
  if (left.length !== right.length || !timingSafeEqual(left, right)) {
    return { ok: false, reason: 'BAD_SIGNATURE' }
  }
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as PkceCookiePayload
    if (typeof payload.verifier !== 'string' || typeof payload.state !== 'string') {
      return { ok: false, reason: 'MALFORMED' }
    }
    return { ok: true, payload }
  } catch {
    return { ok: false, reason: 'MALFORMED' }
  }
}
