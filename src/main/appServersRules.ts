// The app-wide trek-server list, validated; and the hello-token injection the relay does. Pure.
import { isLoopbackUrl, originOf } from '../shared/appServerRules.ts'
import { isLocalEntryId } from '../shared/appServerRules.ts'
import type { LocalServerStatus } from '../shared/types.ts'

export interface AppServer {
  /** Client-side id */
  id: string
  name: string
  url: string
  /** The synthetic Local entry only (localServer.ts); never in app-servers.json */
  local?: LocalServerStatus
}

export const MAX_NAME = 200

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
    // `local` is the synthetic Local entry's: a saved entry never takes it.
    if (typeof id !== 'string' || !id || isLocalEntryId(id) || ids.has(id)) continue
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
 * The URL as two entries would share it: its origin (scheme, host, port) and path, without
 * trailing slashes (and without any user name, password, query or hash). Null if it does not parse.
 */
export function serverKey(url: string): string | null {
  try {
    const u = new URL(url.trim())
    return `${u.origin}${u.pathname.replace(/\/+$/, '')}`
  } catch {
    return null
  }
}

/**
 * Refuses a URL another entry already has (two connections to one server would
 * notify each of its sessions twice). `selfId` is the entry being edited, so it
 * may keep its own URL.
 */
export function rejectDuplicateServer(list: readonly AppServer[], url: string, selfId: string | null): void {
  const key = serverKey(url)
  if (key === null) return
  const other = list.find((s) => s.id !== selfId && serverKey(s.url) === key)
  if (other) throw new Error(`This server is already in the list as "${other.name}"`)
}

/**
 * Refuses a saved entry for the Local server's current URL (`localUrl`, null when it is
 * not running): Local is listed first and connected by Trek itself, with a token that
 * changes on each restart. Any loopback name (localhost, 127.0.0.1, ::1) on its port counts.
 */
export function rejectLocalServerUrl(url: string, localUrl: string | null): void {
  if (localUrl === null) return
  const key = serverKey(url)
  if (key === null) return
  let same = key === serverKey(localUrl)
  if (!same && isLoopbackUrl(url)) {
    const a = new URL(url.trim())
    const b = new URL(localUrl)
    same = a.protocol === b.protocol && a.port === b.port && a.pathname.replace(/\/+$/, '') === ''
  }
  if (same) throw new Error('This is the Local server (listed first). Trek connects to it itself, so it needs no entry.')
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

/**
 * The name an entry added by the importer gets (addAppServer): the file's name for the server,
 * trimmed and cut to Save's limit, or the URL's host when that leaves nothing.
 */
export function addedServerName(name: unknown, url: string): string {
  const trimmed = typeof name === 'string' ? name.trim().slice(0, MAX_NAME).trim() : ''
  if (trimmed) return trimmed
  try {
    return new URL(url.trim()).host || url.trim().slice(0, MAX_NAME) || 'Server'
  } catch {
    return url.trim().slice(0, MAX_NAME) || 'Server'
  }
}

/**
 * Whether the importer may store a carried token for entry `id` (adoptAppServerToken): a saved
 * entry (never Local) that still points at `url`, the address the token was matched to. Whether
 * the entry has a token already is the secret store's to decide, in the same step (setIfAbsent).
 */
export function mayAdoptToken(id: string, now: AppServer | undefined, url: string): boolean {
  return !isLocalEntryId(id) && !!now && now.id === id && now.url === url
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

/**
 * The server URL a pairing QR carries (6a): as this app reaches the server, without a user name or
 * password (a saved URL can't hold them, but an older entry might). Otherwise as written.
 */
export function pairingUrl(url: string): string {
  const trimmed = url.trim()
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return trimmed
  }
  if (!parsed.username && !parsed.password) return trimmed
  parsed.username = ''
  parsed.password = ''
  const out = parsed.toString()
  // URL adds a "/" to a bare origin; keep the original's shape.
  return parsed.pathname === '/' && !parsed.search && !parsed.hash && !/\/$/.test(trimmed) ? out.replace(/\/$/, '') : out
}

/** A day: a pairing lifetime past this is not believed. */
const MAX_PAIRING_LIFETIME_MS = 24 * 3_600_000

/**
 * When a pairing code expires by this machine's clock (6a): `now` plus the server's `expiresInMs`,
 * so a server whose clock is off doesn't skew the countdown. An older server's (no
 * `expiresInMs`, or a nonsense one): its `expiresAt`.
 */
export function pairingDeadline(result: { expiresAt: number; expiresInMs?: unknown }, now: number): number {
  const ms = result.expiresInMs
  if (typeof ms === 'number' && Number.isFinite(ms) && ms >= 0 && ms <= MAX_PAIRING_LIFETIME_MS) return now + ms
  return result.expiresAt
}
