// The server's config file as live state. The CLI and the v2 RPCs both edit
// repos through this class, so validation is the same; a running server
// watches the file, so CLI edits apply without a restart.
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, readFileSync, watch, type FSWatcher } from 'node:fs'
import { basename, dirname, isAbsolute } from 'node:path'
import type { RemoteRepo } from '../../src/shared/protocol'
import { isRecord } from './validate.ts'
import { saveConfig, type TrekServerConfig } from './config.ts'
import { codedError } from './errors.ts'
import { PathGuard } from './paths.ts'
import { addRepo, removeRepo, resolveRepoRoot, type AddRepoOptions } from './repos.ts'

export interface AddRepoRequest extends AddRepoOptions {
  /**
   * RPC callers may only add repos under an already-allowed root (a registered
   * repo's parent or a worktreeRoot). The CLI runs on the box and may add anywhere.
   */
  requireAllowedRoot: boolean
}

/** Names of the projects using `repo`. */
export type RepoUsage = (repo: RemoteRepo) => string[]

const RELOAD_DEBOUNCE_MS = 100

/** Checks the shape of a parsed config file. Token entries are filtered later by tokens.ts. */
export function validateConfig(raw: unknown): TrekServerConfig {
  if (!isRecord(raw)) throw new Error('config must be a JSON object')
  if (!Array.isArray(raw.repos)) throw new Error('config.repos must be an array')
  raw.repos.forEach((repo, i) => {
    if (!isRecord(repo)) throw new Error(`config.repos[${i}] must be an object`)
    for (const key of ['id', 'name', 'path']) {
      if (typeof repo[key] !== 'string') throw new Error(`config.repos[${i}].${key} must be a string`)
    }
    if (!isAbsolute(repo.path as string)) throw new Error(`config.repos[${i}].path must be an absolute path`)
  })
  if (raw.tokens !== undefined && !Array.isArray(raw.tokens)) throw new Error('config.tokens must be an array')
  if (raw.worktreeRoots !== undefined && (!Array.isArray(raw.worktreeRoots) || raw.worktreeRoots.some((r) => typeof r !== 'string'))) {
    throw new Error('config.worktreeRoots must be an array of strings')
  }
  if (raw.port !== undefined && typeof raw.port !== 'number') throw new Error('config.port must be a number')
  for (const key of ['host', 'serverId', 'name', 'tokenHash', 'dataDir']) {
    if (raw[key] !== undefined && typeof raw[key] !== 'string') throw new Error(`config.${key} must be a string`)
  }
  return raw as unknown as TrekServerConfig
}

export class ConfigStore extends EventEmitter<{ change: [] }> {
  readonly path: string
  private usage: RepoUsage = () => []
  private current: TrekServerConfig
  private currentGuard: PathGuard
  private watcher?: FSWatcher
  private reloadTimer?: NodeJS.Timeout

  private warnedMissing = false
  private warnedServerId = false

  /** Throws if the file exists but is not valid JSON or has the wrong shape. A missing file is an empty config. */
  constructor(path: string) {
    super()
    this.path = path
    this.current = existsSync(path) ? validateConfig(JSON.parse(readFileSync(path, 'utf8'))) : { repos: [] }
    this.currentGuard = new PathGuard(this.current)
  }

  /** Treat as read-only; change it through update(). */
  get config(): TrekServerConfig {
    return this.current
  }

  get guard(): PathGuard {
    return this.currentGuard
  }

  /** Applies `mutate` to a copy, saves it and swaps it in. If `mutate` throws, nothing changes. */
  update(mutate: (config: TrekServerConfig) => void): void {
    this.syncFromDisk()
    const next = structuredClone(this.current)
    mutate(next)
    this.commit(next)
  }

  addRepo(path: string, request: AddRepoRequest): { repo: RemoteRepo; added: boolean } {
    this.syncFromDisk()
    if (request.requireAllowedRoot) this.currentGuard.check(path)
    let root: string
    try {
      root = resolveRepoRoot(path)
    } catch (err) {
      throw codedError('NOT_A_REPO', (err as Error).message)
    }
    if (request.requireAllowedRoot) {
      this.currentGuard.check(root)
      // Adding must not widen the guard beyond space that is already allowed.
      this.currentGuard.check(dirname(root))
    }
    const next = structuredClone(this.current)
    const result = addRepo(next, root, { id: request.id, name: request.name })
    if (result.added) this.commit(next)
    return result
  }

  /** Who uses a repo: the project state sets this so removeRepo can refuse with IN_USE. */
  setUsage(usage: RepoUsage): void {
    this.usage = usage
  }

  /** By id, or by path (or a path inside the checkout). `idOnly` skips the path fallback. */
  removeRepo(target: string, options: { idOnly?: boolean } = {}): RemoteRepo {
    this.syncFromDisk()
    const next = structuredClone(this.current)
    let removed: RemoteRepo | undefined
    if (options.idOnly) {
      const index = next.repos.findIndex((r) => r.id === target)
      if (index !== -1) [removed] = next.repos.splice(index, 1)
    } else {
      removed = removeRepo(next, target)
    }
    if (!removed) throw codedError('NOT_FOUND', `No configured repo matches "${target}"`)
    const users = this.usage(removed)
    if (users.length > 0) {
      throw codedError('IN_USE', `${removed.name} is used by: ${users.join(', ')}`)
    }
    this.commit(next)
    return removed
  }

  /** Re-reads the file. Returns true (and emits change) if it differs from what is loaded. */
  reload(): boolean {
    let next: TrekServerConfig
    if (!existsSync(this.path)) {
      if (!this.warnedMissing) console.warn(`[config] ${this.path} does not exist; keeping the current config`)
      this.warnedMissing = true
      return false
    }
    this.warnedMissing = false
    try {
      next = validateConfig(JSON.parse(readFileSync(this.path, 'utf8')))
      this.keepIdentity(next)
      if (JSON.stringify(next) === JSON.stringify(this.current)) return false
      this.swap(next)
    } catch (err) {
      console.warn(`[config] ignoring invalid ${this.path}: ${(err as Error).message}`)
      return false
    }
    return true
  }

  /** A reloaded file must not change the running server's identity. */
  private keepIdentity(next: TrekServerConfig): void {
    const { serverId, name } = this.current
    if (serverId && next.serverId !== serverId) {
      if (!this.warnedServerId) console.warn('[config] serverId changes are ignored until restart')
      this.warnedServerId = true
      next.serverId = serverId
    }
    if (name && !next.name) next.name = name
  }

  /** Watches the file's directory (atomic saves replace the file) and reloads on change. */
  watch(): void {
    if (this.watcher) return
    mkdirSync(dirname(this.path), { recursive: true })
    const watcher = watch(dirname(this.path), (_event, file) => {
      if (file && file.toString() !== basename(this.path)) return
      clearTimeout(this.reloadTimer)
      this.reloadTimer = setTimeout(() => {
        try {
          this.reload()
        } catch (err) {
          console.warn(`[config] reload failed: ${(err as Error).message}`)
        }
      }, RELOAD_DEBOUNCE_MS)
    })
    watcher.on('error', (err) => {
      console.warn(`[config] watcher for ${this.path} failed: ${err.message}`)
      this.watcher?.close()
      this.watcher = undefined
    })
    this.watcher = watcher
  }

  close(): void {
    this.watcher?.close()
    this.watcher = undefined
    clearTimeout(this.reloadTimer)
  }

  /** Each read-modify-write starts from the file on disk, so CLI edits are not lost. */
  private syncFromDisk(): void {
    clearTimeout(this.reloadTimer)
    this.reload()
  }

  private commit(next: TrekServerConfig): void {
    // Build the guard first: if it throws, neither disk nor memory has changed.
    const guard = new PathGuard(next)
    saveConfig(this.path, next)
    this.current = next
    this.currentGuard = guard
    this.emit('change')
  }

  private swap(next: TrekServerConfig): void {
    const guard = new PathGuard(next)
    this.current = next
    this.currentGuard = guard
    this.emit('change')
  }
}
