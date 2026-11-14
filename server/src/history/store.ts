// Each project's worktree history: `<dir>/<projectId>.jsonl`, one HistoryEvent per line, appended.
// A line whose id was seen before replaces that event and makes it the branch's newest (a note
// edit folded into the entry before it). Each branch keeps its newest `maxPerBranch` events; the
// file is rewritten once it holds more than twice as many lines as live events (+50). A failed
// write is a health warning and never throws: the history must never block the change it records.
import { appendFileSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomic } from '../../../src/host/atomicWrite.ts'
import { HISTORY_PAGE_SIZE, MAX_HISTORY_PER_BRANCH, isHistoryEvent, type HistoryEvent, type HistoryPage } from '../../../src/shared/model/history.ts'
import type { HealthWarning } from '../../../src/shared/model/types'

export interface HistoryStoreOptions {
  /** Default MAX_HISTORY_PER_BRANCH */
  maxPerBranch?: number
  /** After each record (the server emits `history.added`) */
  onRecorded?: (projectId: string, event: HistoryEvent) => void
  /** The health warning appeared or cleared */
  onHealth?: () => void
}

interface Loaded {
  /** `${repoId}\0${branch}` → its events, oldest first */
  branches: Map<string, HistoryEvent[]>
  /** Lines in the file */
  lines: number
}

const keyOf = (repoId: string, branch: string): string => `${repoId}\0${branch}`

export class HistoryStore {
  private readonly dir: string
  private readonly max: number
  private readonly options: HistoryStoreOptions
  private readonly projects = new Map<string, Loaded>()
  /** Projects whose last write or read failed → the message; the warning shows while any is here */
  private readonly problems = new Map<string, string>()
  private warning?: HealthWarning
  /** Projects whose file may lack events held in memory (a failed write, a torn last line): the next write rewrites the file */
  private readonly dirty = new Set<string>()
  /** Projects whose file could not be read: never rewritten or deleted, kept in memory only */
  private readonly readFailed = new Set<string>()
  /** Read-failed projects already logged as memory-only (once each) */
  private readonly warnedMemoryOnly = new Set<string>()

  constructor(dir: string, options: HistoryStoreOptions = {}) {
    this.dir = dir
    this.options = options
    this.max = options.maxPerBranch ?? MAX_HISTORY_PER_BRANCH
  }

  /** Records an event (an id already there replaces it). Never throws. */
  record(projectId: string, event: HistoryEvent): void {
    if (!isHistoryEvent(event)) {
      console.warn(`[history] refused an invalid ${(event as { kind?: unknown })?.kind} event for ${projectId}`)
      return
    }
    const loaded = this.load(projectId)
    this.put(loaded, event)
    if (this.readFailed.has(projectId)) {
      if (!this.warnedMemoryOnly.has(projectId)) {
        this.warnedMemoryOnly.add(projectId)
        console.warn(`[history] ${projectId}: kept in memory only (its file could not be read)`)
      }
    } else if (this.dirty.has(projectId)) {
      this.compact(projectId)
    } else {
      const ok = this.write(projectId, () => {
        mkdirSync(this.dir, { recursive: true, mode: 0o700 })
        appendFileSync(this.file(projectId), JSON.stringify(event) + '\n', { mode: 0o600 })
      })
      loaded.lines++
      if (ok && loaded.lines > 2 * this.live(loaded) + 50) this.compact(projectId)
    }
    try {
      this.options.onRecorded?.(projectId, event)
    } catch (err) {
      console.warn(`[history] ${(err as Error).message}`)
    }
  }

  /** The branch's newest event */
  latest(projectId: string, repoId: string, branch: string): HistoryEvent | undefined {
    const list = this.load(projectId).branches.get(keyOf(repoId, branch))
    return list?.[list.length - 1]
  }

  /** Newest first: `limit` events older than `before` (an event id; an unknown one gives none) */
  list(projectId: string, repoId: string, branch: string, options: { before?: string; limit?: number } = {}): HistoryPage {
    const all = this.load(projectId).branches.get(keyOf(repoId, branch)) ?? []
    let end = all.length
    if (options.before !== undefined) {
      const at = all.findIndex((e) => e.id === options.before)
      end = at >= 0 ? at : 0
    }
    const asked = Number.isFinite(options.limit) ? Math.floor(options.limit as number) : HISTORY_PAGE_SIZE
    const start = Math.max(0, end - Math.min(Math.max(asked, 1), HISTORY_PAGE_SIZE))
    return { events: all.slice(start, end).reverse(), more: start > 0 }
  }

  /** Every event of a branch, oldest first (a move carries them) */
  branch(projectId: string, repoId: string, branch: string): HistoryEvent[] {
    return [...(this.load(projectId).branches.get(keyOf(repoId, branch)) ?? [])]
  }

  /** A move's events, re-keyed to this repository and branch; ids already here are skipped. The ids added. */
  import(projectId: string, repoId: string, branch: string, events: readonly HistoryEvent[]): string[] {
    const loaded = this.load(projectId)
    const current = this.branch(projectId, repoId, branch)
    const have = new Set(current.map((e) => e.id))
    const added = events.filter((e) => !have.has(e.id)).map((e) => ({ ...e, repoId, branch }))
    if (added.length === 0) return []
    const merged = [...current, ...added].sort((a, b) => a.at - b.at).slice(-this.max)
    loaded.branches.set(keyOf(repoId, branch), merged)
    this.compact(projectId)
    return added.map((e) => e.id)
  }

  /** Takes these events out of a branch (a move undone) */
  remove(projectId: string, repoId: string, branch: string, ids: readonly string[]): void {
    if (ids.length === 0) return
    const loaded = this.load(projectId)
    const key = keyOf(repoId, branch)
    const drop = new Set(ids)
    const had = loaded.branches.get(key) ?? []
    const left = had.filter((e) => !drop.has(e.id))
    if (left.length === had.length) return
    if (left.length > 0) loaded.branches.set(key, left)
    else loaded.branches.delete(key)
    this.compact(projectId)
  }

  /** A repository left the project */
  dropRepo(projectId: string, repoId: string): void {
    const loaded = this.load(projectId)
    const keys = [...loaded.branches.keys()].filter((key) => key.startsWith(`${repoId}\0`))
    if (keys.length === 0) return
    for (const key of keys) loaded.branches.delete(key)
    this.compact(projectId)
  }

  /** The project was deleted */
  dropProject(projectId: string): void {
    if (this.readFailed.has(projectId)) {
      console.warn(`[history] ${projectId}: not deleting a file that could not be read`)
      // The file stays, but the deleted project's memory and warning go
      this.readFailed.delete(projectId)
      this.projects.delete(projectId)
      this.dirty.delete(projectId)
      this.clearProblem(projectId)
      return
    }
    const ok = this.write(projectId, () => {
      try {
        unlinkSync(this.file(projectId))
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      }
    })
    if (ok) {
      this.projects.delete(projectId)
      this.dirty.delete(projectId)
    }
  }

  health(): HealthWarning[] {
    return this.warning ? [this.warning] : []
  }

  private file(projectId: string): string {
    return join(this.dir, `${projectId}.jsonl`)
  }

  private load(projectId: string): Loaded {
    const cached = this.projects.get(projectId)
    if (cached) return cached
    const loaded: Loaded = { branches: new Map(), lines: 0 }
    let text = ''
    try {
      text = readFileSync(this.file(projectId), 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn(`[history] could not read ${projectId}: ${(err as Error).message}`)
        this.readFailed.add(projectId)
        this.setProblem(projectId, `Could not read worktree history: ${(err as Error).message}`)
      }
    }
    // A torn last line (a crash mid-append): the next append would be glued to it
    if (text !== '' && !text.endsWith('\n')) this.dirty.add(projectId)
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      loaded.lines++
      let event: unknown
      try {
        event = JSON.parse(line)
      } catch {
        event = undefined
      }
      if (isHistoryEvent(event)) this.put(loaded, event)
      else console.warn(`[history] skipped a bad line in ${projectId}.jsonl`)
    }
    this.projects.set(projectId, loaded)
    return loaded
  }

  private put(loaded: Loaded, event: HistoryEvent): void {
    const key = keyOf(event.repoId, event.branch)
    const list = loaded.branches.get(key) ?? []
    const at = list.findIndex((e) => e.id === event.id)
    if (at >= 0) list.splice(at, 1)
    list.push(event)
    if (list.length > this.max) list.splice(0, list.length - this.max)
    loaded.branches.set(key, list)
  }

  private live(loaded: Loaded): number {
    let count = 0
    for (const list of loaded.branches.values()) count += list.length
    return count
  }

  private compact(projectId: string): void {
    const loaded = this.load(projectId)
    if (this.readFailed.has(projectId)) return
    const events = [...loaded.branches.values()].flat().sort((a, b) => a.at - b.at)
    const ok = this.write(projectId, () => {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 })
      writeFileAtomic(this.file(projectId), events.map((e) => JSON.stringify(e) + '\n').join(''), 0o600)
    })
    if (ok) {
      this.dirty.delete(projectId)
      loaded.lines = events.length
    }
  }

  private write(projectId: string, fn: () => void): boolean {
    try {
      fn()
      this.clearProblem(projectId)
      return true
    } catch (err) {
      console.warn(`[history] ${projectId}: ${(err as Error).message}`)
      this.dirty.add(projectId)
      this.setProblem(projectId, `Could not save worktree history: ${(err as Error).message}`)
      return false
    }
  }

  private setProblem(projectId: string, message: string): void {
    const before = this.warning
    this.problems.set(projectId, message)
    const shown = this.problems.values().next().value as string
    if (before && before.message === shown) return
    this.warning = { code: 'HISTORY_FAILED', message: shown, since: before?.since ?? Date.now() }
    this.healthChanged()
  }

  private clearProblem(projectId: string): void {
    // A project that could not be read stays a problem until restart
    if (!this.problems.has(projectId) || this.readFailed.has(projectId)) return
    this.problems.delete(projectId)
    if (this.problems.size > 0) {
      const shown = this.problems.values().next().value as string
      if (this.warning && this.warning.message !== shown) {
        this.warning = { ...this.warning, message: shown }
        this.healthChanged()
      }
      return
    }
    this.warning = undefined
    this.healthChanged()
  }

  private healthChanged(): void {
    try {
      this.options.onHealth?.()
    } catch (err) {
      console.warn(`[history] ${(err as Error).message}`)
    }
  }
}
