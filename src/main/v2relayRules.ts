// The relay's bookkeeping, without Electron or sockets: which window owns which
// socket, which windows are already watched, and the close-code rules. Pure.
import { SERVER_REMOVED_MESSAGE } from '../shared/client/index.ts'

export interface RelayEntry<Owner> {
  id: string
  serverEntryId: string
  owner: Owner
}

/** WebSocket.close() throws for any code but 1000 and 3000–4999. */
export function clampCloseCode(code: unknown): number {
  return typeof code === 'number' && Number.isInteger(code) && (code === 1000 || (code >= 3000 && code <= 4999))
    ? code
    : 1000
}

const MAX_REASON_BYTES = 123

/** WebSocket.close() throws for a reason over 123 UTF-8 bytes; cut it on a character boundary. */
export function clampCloseReason(reason: unknown): string {
  if (typeof reason !== 'string') return ''
  let out = ''
  let bytes = 0
  for (const ch of reason) {
    const size = Buffer.byteLength(ch, 'utf8')
    if (bytes + size > MAX_REASON_BYTES) break
    out += ch
    bytes += size
  }
  return out
}

/** Per window: past this, an open is refused (a runaway renderer cannot exhaust sockets). */
export const MAX_SOCKETS_PER_OWNER = 16

export class RelayTable<Owner extends object, Entry extends RelayEntry<Owner>> {
  private readonly entries = new Map<string, Entry>()
  private readonly watched = new WeakSet<Owner>()
  private readonly generations = new WeakMap<Owner, number>()
  private readonly maxPerOwner: number

  constructor(maxPerOwner: number = MAX_SOCKETS_PER_OWNER) {
    this.maxPerOwner = maxPerOwner
  }

  get size(): number {
    return this.entries.size
  }

  add(entry: Entry): void {
    this.entries.set(entry.id, entry)
  }

  /** True if it was there: a socket's close is reported once, and never after its window moved on. */
  delete(id: string): boolean {
    return this.entries.delete(id)
  }

  has(id: string): boolean {
    return this.entries.has(id)
  }

  /** True when `owner` already holds the maximum number of sockets. */
  atCapacity(owner: Owner): boolean {
    let count = 0
    for (const e of this.entries.values()) if (e.owner === owner && ++count >= this.maxPerOwner) return true
    return false
  }

  /** Bumped on each navigation, reload or crash of the window's page. */
  generation(owner: Owner): number {
    return this.generations.get(owner) ?? 0
  }

  /** The window's page went away: an open begun before this must not complete. */
  bumpGeneration(owner: Owner): number {
    const next = this.generation(owner) + 1
    this.generations.set(owner, next)
    return next
  }

  /** The entry, only if `owner` opened it: a window can never act on another's socket. */
  owned(socketId: unknown, owner: Owner): Entry | undefined {
    if (typeof socketId !== 'string') return undefined
    const entry = this.entries.get(socketId)
    return entry && entry.owner === owner ? entry : undefined
  }

  forServer(serverEntryId: string): Entry[] {
    return [...this.entries.values()].filter((e) => e.serverEntryId === serverEntryId)
  }

  forOwner(owner: Owner): Entry[] {
    return [...this.entries.values()].filter((e) => e.owner === owner)
  }

  /** True the first time for each owner, so each window gets its listeners once. */
  watch(owner: Owner): boolean {
    if (this.watched.has(owner)) return false
    this.watched.add(owner)
    return true
  }
}

export type RelayRefusal = { ok: false; removed: boolean; reason: string }

/** The entry is not in the list: final only once a remove has written it (`removing` false), since a failed one puts it back. */
export function goneRefusal(removing: boolean): RelayRefusal {
  return removing
    ? { ok: false, removed: false, reason: 'Server being removed' }
    : { ok: false, removed: true, reason: SERVER_REMOVED_MESSAGE }
}

/**
 * An open's check of the entry once its token is read, against `before` (the
 * entry when the open began): removed meanwhile is `goneRefusal`; re-pointed
 * meanwhile is temporary (the next open reads the new URL and token). null:
 * the token may go to `before.url`.
 */
export function relayRefusal(before: { url: string }, now: { url: string } | undefined, removing: boolean): RelayRefusal | null {
  if (!now) return goneRefusal(removing)
  if (now.url !== before.url) return { ok: false, removed: false, reason: 'Server changed' }
  return null
}
