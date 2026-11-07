// The app-wide trek-server list, validated; and the hello-token injection the relay does. Pure.
import { originOf } from '../shared/appServerRules.ts'

export interface AppServer {
  /** Client-side id */
  id: string
  name: string
  url: string
}

const MAX_NAME = 200

function wsUrl(value: string): boolean {
  try {
    const u = new URL(value)
    return u.protocol === 'ws:' || u.protocol === 'wss:'
  } catch {
    return false
  }
}

export function parseAppServers(raw: unknown): AppServer[] {
  if (!Array.isArray(raw)) return []
  const out: AppServer[] = []
  const ids = new Set<string>()
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const { id, name, url } = item as Record<string, unknown>
    if (typeof id !== 'string' || !id || ids.has(id)) continue
    if (typeof name !== 'string' || !name || typeof url !== 'string' || !wsUrl(url)) continue
    ids.add(id)
    out.push({ id, name, url })
  }
  return out
}

export function validateServerInput(input: { name: unknown; url: unknown }): { name: string; url: string } {
  const name = typeof input.name === 'string' ? input.name.trim() : ''
  if (!name || name.length > MAX_NAME) throw new Error(`name must be 1–${MAX_NAME} characters`)
  const url = typeof input.url === 'string' ? input.url.trim() : ''
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error('URL is not valid')
  }
  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') throw new Error('URL must start with ws:// or wss://')
  if (parsed.username || parsed.password) throw new Error('URL must not contain a user name or password')
  return { name, url }
}

/**
 * Editing an entry's URL to another origin (scheme, host or port) must not carry
 * the stored token there: a renderer could otherwise point a saved token at a host
 * it picks. Clear it unless the same call supplies a new, non-empty token.
 */
export function shouldClearToken(oldUrl: string, newUrl: string, tokenGiven: boolean): boolean {
  if (tokenGiven) return false
  const before = originOf(oldUrl)
  return before === null || before !== originOf(newUrl)
}

/** The relay's only change to outgoing frames: a hello carries the stored token. */
export function withToken(text: string, token: string): string {
  let frame: unknown
  try {
    frame = JSON.parse(text)
  } catch {
    return text
  }
  if (!frame || typeof frame !== 'object' || (frame as { type?: unknown }).type !== 'hello') return text
  return JSON.stringify({ ...(frame as object), token })
}

/** A remove in progress: the entry, and where it stood in the list. */
export interface RemovingEntry {
  entry: AppServer
  index: number
}

/** `item` back into `list` at `index` (at the end when the list has shrunk past it since). */
export function reinsertAt<T>(list: T[], index: number, item: T): void {
  list.splice(Math.min(Math.max(index, 0), list.length), 0, item)
}

/**
 * The list as main's connections and their snapshots see it: copies of `list`,
 * with each entry a remove has not yet written back at its old place.
 */
export function withRemoving(list: readonly AppServer[], removing: Iterable<RemovingEntry>): AppServer[] {
  const out = list.map((s) => ({ ...s }))
  for (const { entry, index } of removing) reinsertAt(out, index, { ...entry })
  return out
}

/** Test's refusal once its token is read, if the entry was removed or re-pointed meanwhile: that token goes nowhere. */
export function testTokenRefusal(url: string, now: AppServer | undefined): { status: 'error'; message: string } | null {
  return now?.url === url ? null : { status: 'error', message: 'Server changed' }
}

/**
 * After a Test of `url`: main's own connection retries at once only when the
 * server took the token, and the entry still points there and is not being removed.
 */
export function shouldRetryAfterTest(result: { status: string }, url: string, now: AppServer | undefined, removing: boolean): boolean {
  return result.status === 'connected' && now?.url === url && !removing
}
