// The target's staged uploads of a worktree move's Claude histories (phase 5d): `move.begin` opens
// a transfer, `move.upload` appends each history's chunks in order, and `move.receive` takes the
// files (or `move.abort` drops them). Each transfer is a 0700 temp directory; one left idle for
// MOVE_TRANSFER_IDLE_MS is removed by the next call that sweeps (every move.* call does), so a
// client that vanished mid-move leaves nothing for long.
import { randomUUID } from 'node:crypto'
import { lstat, mkdtemp, open, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MAX_MOVE_CHUNK_BYTES,
  MAX_MOVE_HISTORY_SESSION_BYTES,
  MAX_MOVE_SESSIONS,
  MAX_MOVE_TRANSFER_BYTES,
  MAX_MOVE_TRANSFERS,
  MOVE_TRANSFER_IDLE_MS
} from '../../../src/shared/move.ts'
import { codedError } from '../errors.ts'

const bad = (message: string): Error => codedError('BAD_REQUEST', message)
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const TRANSFER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/

interface Transfer {
  dir: string
  projectId: string
  repoId: string
  /** agentSessionId → bytes written so far */
  sizes: Map<string, number>
  total: number
  usedAt: number
  /** An upload is writing: a second one for the transfer waits its turn by being refused */
  busy: boolean
  /** Aborted (or cleared) while an upload was writing: its directory goes once the write ends */
  dropped?: boolean
}

/** What `move.receive` takes: the staged files, by agent session id. */
export interface StagedHistories {
  file(agentSessionId: string): string | undefined
  size(agentSessionId: string): number
  /** Removes the transfer's directory */
  discard(): Promise<void>
}

export class MoveTransfers {
  private readonly transfers = new Map<string, Transfer>()
  private readonly now: () => number
  private readonly root: string

  /** `root`: where the transfers' directories go (the OS temp directory) */
  constructor(now: () => number = Date.now, root: string = tmpdir()) {
    this.now = now
    this.root = root
  }

  /** Drops every transfer idle for longer than MOVE_TRANSFER_IDLE_MS. */
  async sweep(): Promise<void> {
    const cutoff = this.now() - MOVE_TRANSFER_IDLE_MS
    for (const [id, t] of this.transfers) {
      if (t.usedAt < cutoff && !t.busy) {
        this.transfers.delete(id)
        await rm(t.dir, { recursive: true, force: true })
      }
    }
  }

  async begin(projectId: string, repoId: string): Promise<string> {
    await this.sweep()
    if (this.transfers.size >= MAX_MOVE_TRANSFERS) throw codedError('CAPACITY', `at most ${MAX_MOVE_TRANSFERS} moves can upload at once; try again shortly`)
    const id = randomUUID()
    const dir = await mkdtemp(join(this.root, 'trek-move-'))
    this.transfers.set(id, { dir, projectId, repoId, sizes: new Map(), total: 0, usedAt: this.now(), busy: false })
    return id
  }

  private get(transferId: unknown): Transfer {
    if (typeof transferId !== 'string' || !TRANSFER_ID.test(transferId)) throw bad('transferId must be what move.begin returned')
    const t = this.transfers.get(transferId)
    if (!t) throw codedError('NOT_FOUND', 'No such transfer (it finished, was aborted, or sat idle too long)')
    return t
  }

  /** Appends one chunk at `offset`, which must be what is already staged for the session. Returns the new size. */
  async append(transferId: unknown, agentSessionId: unknown, offset: unknown, data: unknown): Promise<number> {
    await this.sweep()
    const t = this.get(transferId)
    if (typeof agentSessionId !== 'string' || !SESSION_ID.test(agentSessionId)) throw bad('agentSessionId must be a session id')
    if (typeof data !== 'string' || !BASE64.test(data) || data.length % 4 !== 0) throw bad('data must be base64')
    const bytes = Buffer.from(data, 'base64')
    if (bytes.length === 0) throw bad('data must not be empty')
    if (bytes.length > MAX_MOVE_CHUNK_BYTES) throw bad(`a chunk must be at most ${MAX_MOVE_CHUNK_BYTES} bytes`)
    const size = t.sizes.get(agentSessionId)
    if (size === undefined && t.sizes.size >= MAX_MOVE_SESSIONS) throw bad(`a move carries at most ${MAX_MOVE_SESSIONS} histories`)
    const at = size ?? 0
    if (offset !== at) throw codedError('CONFLICT', `the next chunk of ${agentSessionId} starts at ${at}, not ${String(offset)}`)
    if (at + bytes.length > MAX_MOVE_HISTORY_SESSION_BYTES) throw bad(`a history must be at most ${MAX_MOVE_HISTORY_SESSION_BYTES} bytes`)
    if (t.total + bytes.length > MAX_MOVE_TRANSFER_BYTES) throw bad(`a move carries at most ${MAX_MOVE_TRANSFER_BYTES} bytes of histories`)
    if (t.busy) throw codedError('CONFLICT', 'another chunk of this transfer is being written; send them one at a time')
    t.busy = true
    try {
      const handle = await open(join(t.dir, `${agentSessionId}.jsonl`), at === 0 ? 'w' : 'a', 0o600)
      try {
        await handle.write(bytes)
      } finally {
        await handle.close()
      }
      t.sizes.set(agentSessionId, at + bytes.length)
      t.total += bytes.length
      t.usedAt = this.now()
      return at + bytes.length
    } finally {
      t.busy = false
      if (t.dropped) await rm(t.dir, { recursive: true, force: true })
    }
  }

  /** Ends the transfer for `move.receive` (for this project and repository only); the caller discards it. */
  take(transferId: unknown, projectId: string, repoId: string): StagedHistories {
    const t = this.get(transferId)
    if (t.projectId !== projectId || t.repoId !== repoId) throw bad('the transfer was begun for another repository')
    if (t.busy) throw codedError('CONFLICT', 'a chunk of this transfer is still being written')
    this.transfers.delete(transferId as string)
    return {
      file: (id) => (t.sizes.has(id) ? join(t.dir, `${id}.jsonl`) : undefined),
      size: (id) => t.sizes.get(id) ?? 0,
      discard: () => rm(t.dir, { recursive: true, force: true })
    }
  }

  /**
   * Drops a transfer; an unknown or finished one is fine (the client may abort after a lost
   * answer). One with a chunk being written is gone at once for every later call, and its
   * directory goes when that write ends.
   */
  async abort(transferId: unknown): Promise<void> {
    if (typeof transferId !== 'string') return
    const t = this.transfers.get(transferId)
    if (!t) return
    this.transfers.delete(transferId)
    await this.drop(t)
  }

  private async drop(t: Transfer): Promise<void> {
    if (t.busy) t.dropped = true
    else await rm(t.dir, { recursive: true, force: true })
  }

  /** Every staged directory, for shutdown */
  async clear(): Promise<void> {
    const all = [...this.transfers.values()]
    this.transfers.clear()
    await Promise.all(all.map((t) => rm(t.dir, { recursive: true, force: true })))
  }

  get size(): number {
    return this.transfers.size
  }
}

/** A `trek-move-*` directory (a transfer, or `trek-move-index-*`, an export's throwaway index) older than this is stale at startup */
export const STALE_MOVE_DIR_MS = 60 * 60_000

/**
 * At startup: removes the `trek-move-*` directories (transfers and `trek-move-index-*` export
 * indexes) a killed server left in `root`, only real directories this user owns, untouched for
 * STALE_MOVE_DIR_MS (no live transfer sits idle that long, nor does an export run that long).
 */
export async function sweepStaleMoveDirs(root: string = tmpdir(), now: number = Date.now()): Promise<void> {
  const names = await readdir(root).catch(() => [] as string[])
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined
  for (const name of names) {
    if (!/^trek-move-(?:index-)?[A-Za-z0-9]{6}$/.test(name)) continue
    const dir = join(root, name)
    const info = await lstat(dir).catch(() => null)
    if (!info?.isDirectory() || (uid !== undefined && info.uid !== uid) || now - info.mtimeMs < STALE_MOVE_DIR_MS) continue
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

/** The server's one store of staged transfers */
export const moveTransfers = new MoveTransfers()
