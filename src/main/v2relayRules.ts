// The relay's bookkeeping, without Electron or sockets: which window owns which
// socket, which windows are already watched, and the close-code rules. Pure.

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

export class RelayTable<Owner extends object, Entry extends RelayEntry<Owner>> {
  private readonly entries = new Map<string, Entry>()
  private readonly watched = new WeakSet<Owner>()

  get size(): number {
    return this.entries.size
  }

  add(entry: Entry): void {
    this.entries.set(entry.id, entry)
  }

  delete(id: string): void {
    this.entries.delete(id)
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
