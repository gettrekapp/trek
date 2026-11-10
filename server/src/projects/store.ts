// One JSON file per project, `<dir>/<projectId>.json` = {schema, project}.
// Saves are debounced per project and retried while they fail; failures and
// unreadable files are reported as health warnings for the `server` topic.
import { EventEmitter } from 'node:events'
import { existsSync, readdirSync, readFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import type { HealthWarning, Project } from '../../../src/shared/model/types'
import { writeFileAtomic } from '../../../src/host/atomicWrite.ts'
import { isRecord } from '../validate.ts'
import { collectIds, resetRuntime } from './model.ts'

export const STORE_SCHEMA = 1

export interface ProjectStoreOptions {
  /** Delay between a change and its write (default 200 ms) */
  debounceMs?: number
  /** Longest a change may wait for its write while saves keep coming (default 2 s) */
  maxWaitMs?: number
  /** Delay before retrying failed writes (default 5 s) */
  retryMs?: number
}

/** Shape check of the stored wrapper and the project's top level; resets runtime state. */
function decode(raw: unknown, file: string): Project {
  if (!isRecord(raw)) throw new Error('not a JSON object')
  if (!Number.isInteger(raw.schema) || (raw.schema as number) < 1) throw new Error('schema must be an integer of at least 1')
  if ((raw.schema as number) > STORE_SCHEMA) throw new Error(`schema ${raw.schema} is newer than this server (${STORE_SCHEMA})`)
  const p = raw.project
  if (
    !isRecord(p) || typeof p.id !== 'string' || p.id === '' || typeof p.name !== 'string' ||
    !isRecord(p.settings) || !Array.isArray(p.repositories) || p.repositories.length === 0 ||
    !Array.isArray(p.globalSessions)
  ) {
    throw new Error('project has the wrong shape')
  }
  if (`${p.id}.json` !== file) throw new Error(`holds project ${p.id}`)
  try {
    return resetRuntime(p as unknown as Project)
  } catch (err) {
    throw new Error(`project has the wrong shape: ${(err as Error).message}`)
  }
}

export class ProjectStore extends EventEmitter<{ health: [] }> {
  private readonly dir: string
  private readonly debounceMs: number
  private readonly maxWaitMs: number
  private readonly retryMs: number
  /** When each project's oldest unsaved change was queued. */
  private firstPending = new Map<string, number>()
  private pending = new Map<string, Project>()
  private timers = new Map<string, NodeJS.Timeout>()
  /** Ids whose last write failed; PERSIST_FAILED is set while this is non-empty. */
  private failed = new Set<string>()
  private retryTimer?: NodeJS.Timeout
  private loadFailed?: HealthWarning
  private persistFailed?: HealthWarning
  private closed = false

  constructor(dir: string, options: ProjectStoreOptions = {}) {
    super()
    this.dir = dir
    this.debounceMs = options.debounceMs ?? 200
    this.maxWaitMs = options.maxWaitMs ?? 2000
    this.retryMs = options.retryMs ?? 5000
  }

  /**
   * Reads every `<id>.json`; bad files, and projects whose ids collide with
   * one already loaded, are skipped and reported as LOAD_FAILED.
   */
  loadAll(): Project[] {
    if (!existsSync(this.dir)) return []
    const projects: Project[] = []
    const failures: string[] = []
    const ids = new Set<string>()
    for (const file of readdirSync(this.dir).sort()) {
      if (!file.endsWith('.json')) continue
      try {
        const project = decode(JSON.parse(readFileSync(join(this.dir, file), 'utf8')), file)
        const own = collectIds(project)
        const clash = [...own].filter((id) => ids.has(id))
        if (clash.length > 0) throw new Error(`ids already used by another project: ${clash.join(', ')}`)
        for (const id of own) ids.add(id)
        projects.push(project)
      } catch (err) {
        failures.push(`${file}: ${(err as Error).message}`)
      }
    }
    if (failures.length > 0) {
      console.warn(`[projects] skipped ${failures.length} file(s) in ${this.dir}:\n  ${failures.join('\n  ')}`)
      this.loadFailed = { code: 'LOAD_FAILED', message: `Skipped project files: ${failures.join('; ')}`, since: Date.now() }
      this.emit('health')
    }
    return projects
  }

  /** Queues `project` to be written; later calls for the same id replace it. A no-op after close(). */
  save(project: Project): void {
    if (this.closed) return
    this.pending.set(project.id, project)
    const now = Date.now()
    const first = this.firstPending.get(project.id) ?? now
    this.firstPending.set(project.id, first)
    clearTimeout(this.timers.get(project.id))
    const wait = Math.max(0, Math.min(this.debounceMs, first + this.maxWaitMs - now))
    this.timers.set(project.id, setTimeout(() => this.guarded(() => this.write(project.id)), wait))
  }

  /**
   * Deletes the file, then drops any pending write. If the delete fails (other
   * than the file being absent) it throws and the pending write is kept.
   */
  remove(projectId: string): void {
    try {
      unlinkSync(this.file(projectId))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
    this.pending.delete(projectId)
    this.firstPending.delete(projectId)
    clearTimeout(this.timers.get(projectId))
    this.timers.delete(projectId)
    this.failed.delete(projectId)
    this.updatePersistHealth()
  }

  /** Writes everything pending now; returns the ids that could not be saved. */
  flush(): string[] {
    for (const id of [...this.pending.keys()]) this.write(id)
    return [...this.failed]
  }

  /** Flushes (returning the ids that failed), stops all timers and ignores later saves. */
  close(): string[] {
    const failed = this.flush()
    this.closed = true
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    clearTimeout(this.retryTimer)
    this.retryTimer = undefined
    return failed
  }

  health(): HealthWarning[] {
    return [this.loadFailed, this.persistFailed].filter((w): w is HealthWarning => w !== undefined)
  }

  private file(projectId: string): string {
    return join(this.dir, `${projectId}.json`)
  }

  /** Timer callbacks: a throwing 'health' listener must not crash the process. */
  private guarded(fn: () => void): void {
    try {
      fn()
    } catch (err) {
      console.warn(`[projects] ${(err as Error).message}`)
    }
  }

  private write(projectId: string): void {
    clearTimeout(this.timers.get(projectId))
    this.timers.delete(projectId)
    this.firstPending.delete(projectId)
    const project = this.pending.get(projectId)
    if (!project) return
    let error: Error | undefined
    try {
      writeFileAtomic(this.file(projectId), JSON.stringify({ schema: STORE_SCHEMA, project }, null, 2) + '\n', 0o600)
    } catch (err) {
      error = err as Error
    }
    if (!error) {
      this.pending.delete(projectId)
      this.failed.delete(projectId)
      this.updatePersistHealth()
      return
    }
    console.warn(`[projects] could not save ${projectId}: ${error.message}`)
    this.failed.add(projectId)
    this.scheduleRetry()
    const message = `Could not save projects: ${error.message}`
    if (!this.persistFailed) {
      this.persistFailed = { code: 'PERSIST_FAILED', message, since: Date.now() }
      this.emit('health')
    } else if (this.persistFailed.message !== message) {
      this.persistFailed = { ...this.persistFailed, message }
      this.emit('health')
    }
  }

  private scheduleRetry(): void {
    if (this.retryTimer || this.closed) return
    this.retryTimer = setTimeout(() => this.guarded(() => {
      this.retryTimer = undefined
      for (const id of [...this.failed]) if (!this.timers.has(id)) this.guarded(() => this.write(id))
      this.updatePersistHealth()
    }), this.retryMs)
  }

  /** Clears PERSIST_FAILED once no project is failing. */
  private updatePersistHealth(): void {
    if (this.failed.size === 0 && this.persistFailed) {
      this.persistFailed = undefined
      this.emit('health')
    }
  }
}
