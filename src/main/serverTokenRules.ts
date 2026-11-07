// v1 (per-project) server tokens: each is bound to the origin it was entered for. Pure.
//
// A v1 server's URL and id live in the .trekproj, which the renderer owns, so main has no
// other record of where a token belongs. Without a binding, a renderer could hand main a
// stored token's server id with a URL of its choosing and have the token sent there.
import { originOf } from '../shared/appServerRules.ts'
import type { ServerTokenCheck } from '../shared/types.ts'

/** A stored token and the origin (scheme, host, port) it was entered for; null = saved before binding. */
export interface StoredServerToken {
  token: string
  origin: string | null
}

const RECORD_TAG = 'trekV1Token'

export const ADDRESS_CHANGED = 'This server’s address changed — enter its token again'
export const TOKEN_UNBOUND = 'Enter this server’s token again: it was saved before tokens were tied to an address'
export const NO_TOKEN = 'No token provided or stored'
export const INVALID_URL = 'Server URL is not valid'

/** The origin of `url`, or null when it has none a token could be bound to (unparseable, or file: and the like). */
function boundOrigin(url: string): string | null {
  const origin = originOf(url)
  return origin && origin !== 'null' ? origin : null
}

/**
 * Why a `server:setToken` call from the renderer must be refused, or null when `token` may be
 * stored bound to `url`. (A null token, which clears, is handled before this.)
 */
export function checkSetToken(token: unknown, url: unknown): string | null {
  if (typeof token !== 'string' || !token) return 'token must be a non-empty string'
  if (typeof url !== 'string' || !url.trim()) return 'Server URL is required'
  return boundOrigin(url) ? null : INVALID_URL
}

/** The secret store's value for `token` entered for `url`. Throws when `url` has no origin. */
export function encodeTokenRecord(token: string, url: string): string {
  const origin = boundOrigin(url)
  if (!origin) throw new Error(INVALID_URL)
  return JSON.stringify({ [RECORD_TAG]: 1, token, origin })
}

/** A stored value back to its token and origin. A value from before binding is the bare token, unbound. */
export function decodeTokenRecord(raw: string): StoredServerToken {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown> | null
    if (
      parsed &&
      typeof parsed === 'object' &&
      parsed[RECORD_TAG] === 1 &&
      typeof parsed.token === 'string' &&
      typeof parsed.origin === 'string'
    ) {
      return { token: parsed.token, origin: parsed.origin }
    }
  } catch {
    // not a record: a bare legacy token
  }
  return { token: raw, origin: null }
}

export type TokenDecision = { ok: true; token: string } | Extract<ServerTokenCheck, { ok: false }>

/**
 * Which token, if any, may be sent to `url`. A token the user typed for this call (`explicit`)
 * goes to the URL it was typed for. A stored token goes only to the origin it was stored for:
 * a different scheme, host or port is refused, and so is one saved before binding (the user
 * enters it once more), so no stored token is ever sent to an origin the renderer picked.
 */
export function tokenToSend(url: string, stored: StoredServerToken | null, explicit?: string): TokenDecision {
  if (explicit) return { ok: true, token: explicit }
  const target = boundOrigin(url)
  if (!target) return { ok: false, reason: 'invalid', error: INVALID_URL }
  if (!stored || !stored.token) return { ok: false, reason: 'none', error: NO_TOKEN }
  if (stored.origin === null) return { ok: false, reason: 'unbound', error: TOKEN_UNBOUND }
  if (target !== stored.origin) return { ok: false, reason: 'changed', error: ADDRESS_CHANGED }
  return { ok: true, token: stored.token }
}

/** What the renderer may learn about a stored token for `url`: whether it would be sent, and if not, why. Never the token. */
export function tokenCheck(url: string, stored: StoredServerToken | null): ServerTokenCheck {
  const decision = tokenToSend(url, stored)
  return decision.ok ? { ok: true } : decision
}
