// One JSON file per project, `<dir>/<projectId>.json` = {schema, project}.
// Saves are debounced per project and retried while they fail; failures and
// unreadable files are reported as health warnings for the `server` topic.
import { EventEmitter } from 'node:events'
import { existsSync, readdirSync, readFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import type { HealthWarning, Project } from '../../../src/shared/model/types'
import { writeFileAtomic } from '../atomicWrite.ts'
import { isRecord } from '../validate.ts'
import { resetRuntime } from './model.ts'

export const STORE_SCHEMA = 1

export interface ProjectStoreOptions {
  /** Delay between a change and its write (default 200 ms) */
  debounceMs?: number
  /** Delay before retrying failed writes (default 5 s) */
  retryMs?: number
}

/** Minimal shape check; anything deeper is the server's own data. */
function decode(raw: unknown, file: string): Project {
  if (!isRecord(raw)) throw new Error('not a JSON object')
  if (typeof raw.schema !== 'number') throw new Error('missing schema')
  if (raw.schema > STORE_SCHEMA) throw new Error(`schema ${raw.schema} is newer than this server (${STORE_SCHEMA})`)
  const p = raw.project
  if (
    !isRecord(p) || typeof p.id !== 'string' || typeof p.name !== 'string' ||
    !isRecord(p.settings) || !Array.isArray(p.repositories) || p.repositories.length === 0 ||
    !Array.isArray(p.globalSessions)
  ) {
    throw new Error('project has the wrong shape')
  }
  if (`${p.id}.json` !== file) throw new Error(`holds project ${p.id}`)
  return p as unknown as Project
}

export class ProjectStore extends EventEmitter<{ health: [] }> {
  private readonly dir: string
  private readonly debounceMs: number
  private readonly retryMs: number
  private pending = new Map<string, Project>()
  private timers = new Map<string, NodeJS.Timeout>()
  private retryTimer?: NodeJS.Timeout
  private loadFailed?: HealthWarning
  private persistFailed?: HealthWarning

  constructor(dir: string, options: ProjectStoreOptions = {}) {
    super()
    this.dir = dir
    this.debounceMs = options.debounceMs ?? 200
    this.retryMs = options.retryMs ?? 5000
  }

  /** Reads every `<id>.json`; bad files are skipped and reported as LOAD_FAILED. */
  loadAll(): Project[] {
    if (!existsSync(this.dir)) return []
    const projects: Project[] = []
    const failures: string[] = []
    for (const file of readdirSync(this.dir).sort()) {
      if (!file.endsWith('.json')) continue
      try {
        projects.push(resetRuntime(decode(JSON.parse(readFileSync(join(this.dir, file), 'utf8')), file)))
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

  /** Queues `project` to be written; later calls for the same id replace it. */
  save(project: Project): void {
    this.pending.set(project.id, project)
    clearTimeout(this.timers.get(project.id))
    this.timers.set(project.id, setTimeout(() => this.write(project.id), this.debounceMs))
  }

  /** Cancels any pending write and deletes the file. */
  remove(projectId: string): void {
    this.pending.delete(projectId)
    clearTimeout(this.timers.get(projectId))
    this.timers.delete(projectId)
    try {
      unlinkSync(this.file(projectId))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
  }

  /** Writes everything pending now (shutdown). */
  flush(): void {
    for (const id of [...this.pending.keys()]) this.write(id)
  }

  close(): void {
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    clearTimeout(this.retryTimer)
    this.retryTimer = undefined
  }

  health(): HealthWarning[] {
    return [this.loadFailed, this.persistFailed].filter((w): w is HealthWarning => w !== undefined)
  }

  private file(projectId: string): string {
    return join(this.dir, `${projectId}.json`)
  }

  private write(projectId: string): void {
    clearTimeout(this.timers.get(projectId))
    this.timers.delete(projectId)
    const project = this.pending.get(projectId)
    if (!project) return
    try {
      writeFileAtomic(this.file(projectId), JSON.stringify({ schema: STORE_SCHEMA, project }, null, 2) + '\n', 0o600)
      this.pending.delete(projectId)
      this.updatePersistHealth()
    } catch (err) {
      console.warn(`[projects] could not save ${projectId}: ${(err as Error).message}`)
      if (!this.persistFailed) {
        this.persistFailed = { code: 'PERSIST_FAILED', message: `Could not save projects: ${(err as Error).message}`, since: Date.now() }
        this.emit('health')
      }
      this.scheduleRetry()
    }
  }

  private scheduleRetry(): void {
    if (this.retryTimer) return
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined
      for (const id of [...this.pending.keys()]) if (!this.timers.has(id)) this.write(id)
    }, this.retryMs)
  }

  private updatePersistHealth(): void {
    const failing = [...this.pending.keys()].some((id) => !this.timers.has(id))
    if (!failing && this.persistFailed) {
      this.persistFailed = undefined
      this.emit('health')
    }
  }
}
