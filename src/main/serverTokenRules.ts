// v1 (per-project) server tokens: each is bound to the origin it was entered for. Pure.
//
// A v1 server's URL and id live in the .trekproj, which the renderer owns, so main has no
// other record of where a token belongs. Without a binding, a renderer could hand main a
// stored token's server id with a URL of its choosing and have the token sent there.
import { originOf } from '../shared/appServerRules.ts'

/** A stored token and the origin (scheme, host, port) it was entered for; null = saved before binding. */
export interface StoredServerToken {
  token: string
  origin: string | null
}

const RECORD_TAG = 'trekV1Token'

export const ADDRESS_CHANGED = 'This server’s address changed — enter its token again'
export const TOKEN_UNBOUND = 'Enter this server’s token again: it was saved before tokens were tied to an address'
export const NO_TOKEN = 'No token provided or stored'

/** The secret store's value for `token` entered for `url`. Throws when `url` has no origin. */
export function encodeTokenRecord(token: string, url: string): string {
  const origin = originOf(url)
  if (!origin || origin === 'null') throw new Error('Server URL is not valid')
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

export type TokenDecision =
  | { ok: true; token: string }
  | { ok: false; reason: 'none' | 'changed' | 'unbound'; error: string }

/**
 * Which token, if any, may be sent to `url`. A token the user typed for this call (`explicit`)
 * goes to the URL it was typed for. A stored token goes only to the origin it was stored for:
 * a different scheme, host or port is refused, and so is one saved before binding (the user
 * enters it once more), so no stored token is ever sent to an origin the renderer picked.
 */
export function tokenToSend(url: string, stored: StoredServerToken | null, explicit?: string): TokenDecision {
  if (explicit) return { ok: true, token: explicit }
  if (!stored || !stored.token) return { ok: false, reason: 'none', error: NO_TOKEN }
  if (stored.origin === null) return { ok: false, reason: 'unbound', error: TOKEN_UNBOUND }
  const target = originOf(url)
  if (!target || target !== stored.origin) return { ok: false, reason: 'changed', error: ADDRESS_CHANGED }
  return { ok: true, token: stored.token }
}
