// The server's config file as live state. The CLI and the v2 RPCs both edit
// repos through this class, so validation is the same; a running server
// watches the file, so CLI edits apply without a restart.
import { EventEmitter } from 'node:events'
import { watch, type FSWatcher } from 'node:fs'
import { basename, dirname } from 'node:path'
import type { RemoteRepo } from '../../src/shared/protocol'
import { loadConfig, saveConfig, type DaemonConfig } from './config.ts'
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

/** Names of the projects using `repo`. Phase 2b supplies the real lookup. */
export type RepoUsage = (repo: RemoteRepo) => string[]

const RELOAD_DEBOUNCE_MS = 100

export class ConfigStore extends EventEmitter<{ change: [] }> {
  readonly path: string
  usage: RepoUsage = () => []
  private current: DaemonConfig
  private currentGuard: PathGuard
  private watcher?: FSWatcher
  private reloadTimer?: NodeJS.Timeout

  /** Throws if the file exists but is not valid JSON. */
  constructor(path: string) {
    super()
    this.path = path
    this.current = loadConfig(path)
    this.currentGuard = new PathGuard(this.current)
  }

  /** Treat as read-only; change it through update(). */
  get config(): DaemonConfig {
    return this.current
  }

  get guard(): PathGuard {
    return this.currentGuard
  }

  /** Applies `mutate` to a copy, saves it and swaps it in. If `mutate` throws, nothing changes. */
  update(mutate: (config: DaemonConfig) => void): void {
    const next = structuredClone(this.current)
    mutate(next)
    this.commit(next)
  }

  addRepo(path: string, request: AddRepoRequest): { repo: RemoteRepo; added: boolean } {
    if (request.requireAllowedRoot) this.currentGuard.check(path)
    let root: string
    try {
      root = resolveRepoRoot(path)
    } catch (err) {
      throw codedError('NOT_A_REPO', (err as Error).message)
    }
    if (request.requireAllowedRoot) this.currentGuard.check(root)
    const next = structuredClone(this.current)
    const result = addRepo(next, root, { id: request.id, name: request.name })
    if (result.added) this.commit(next)
    return result
  }

  /** By id, or by path (or a path inside the checkout). */
  removeRepo(target: string): RemoteRepo {
    const next = structuredClone(this.current)
    const removed = removeRepo(next, target)
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
    let next: DaemonConfig
    try {
      next = loadConfig(this.path)
    } catch (err) {
      console.warn(`[config] ignoring unreadable ${this.path}: ${(err as Error).message}`)
      return false
    }
    if (JSON.stringify(next) === JSON.stringify(this.current)) return false
    this.swap(next)
    return true
  }

  /** Watches the file's directory (atomic saves replace the file) and reloads on change. */
  watch(): void {
    if (this.watcher) return
    this.watcher = watch(dirname(this.path), (_event, file) => {
      if (file && file.toString() !== basename(this.path)) return
      clearTimeout(this.reloadTimer)
      this.reloadTimer = setTimeout(() => this.reload(), RELOAD_DEBOUNCE_MS)
    })
  }

  close(): void {
    this.watcher?.close()
    this.watcher = undefined
    clearTimeout(this.reloadTimer)
  }

  private commit(next: DaemonConfig): void {
    saveConfig(this.path, next)
    this.swap(next)
  }

  private swap(next: DaemonConfig): void {
    this.current = next
    this.currentGuard = new PathGuard(next)
    this.emit('change')
  }
}
