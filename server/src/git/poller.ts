// Keeps each project's worktrees in step with git. Work is per repository
// (keyed by realpath) because several projects can share one registered repo:
// one read feeds all of them. Reads of one repo never overlap (Coalescer).
import { listWorktrees, worktreeStatuses } from '../../../src/host/gitService.ts'
import { parseTopic, projectTopic } from '../../../src/shared/model/topics.ts'
import type { HealthWarning, Project, Repository } from '../../../src/shared/model/types'
import type { RemoteRepo } from '../../../src/shared/protocol'
import type { GitWorktreeInfo, WorktreeStatus } from '../../../src/shared/types'
import type { ProjectState } from '../projects/state.ts'
import { realOrResolved as real } from '../repos.ts'
import type { TopicHub } from '../topicHub.ts'
import { Coalescer } from './coalescer.ts'
import { applyStatuses, reconcileWorktrees } from './reconcile.ts'

export interface GitReader {
  listWorktrees(repoPath: string): Promise<GitWorktreeInfo[]>
  worktreeStatuses(worktreePaths: string[]): Promise<WorktreeStatus[]>
}

export interface PollIntervals {
  /** List cadence while a project using the repo has a subscriber */
  activeListMs: number
  /** Status cadence while a project using the repo has a subscriber */
  activeStatusMs: number
  /** List cadence with no subscribers (no status reads) */
  idleListMs: number
  /** How often the scheduler checks what is due */
  tickMs: number
}

export const DEFAULT_INTERVALS: PollIntervals = { activeListMs: 5_000, activeStatusMs: 30_000, idleListMs: 60_000, tickMs: 1_000 }

export interface GitPollerDeps {
  projects: ProjectState
  hub: TopicHub
  /** The server's registered repos, read fresh on every use */
  registry: () => readonly RemoteRepo[]
  /** Called when health() changes */
  onHealth: () => void
  git?: GitReader
  now?: () => number
  intervals?: Partial<PollIntervals>
}

interface RepoUse {
  /** The path as projects spell it */
  path: string
  projectIds: string[]
}

interface ListResult {
  /** The list was read and applied */
  listed: boolean
  /** Statuses are stale (a row was added or restored, or a head moved) */
  stale: boolean
}

interface Clock {
  lastList: number
  lastStatus: number
}

const NEVER = Number.NEGATIVE_INFINITY

export class GitPoller {
  private readonly deps: GitPollerDeps
  private readonly git: GitReader
  private readonly now: () => number
  private readonly intervals: PollIntervals
  private readonly clocks = new Map<string, Clock>()
  private readonly warnings = new Map<string, HealthWarning>()
  private readonly runs = new Coalescer()
  private timer?: NodeJS.Timeout
  private unwatch?: () => void
  private lastTick: Promise<void> = Promise.resolve()
  private stopped = false

  constructor(deps: GitPollerDeps) {
    this.deps = deps
    this.git = deps.git ?? { listWorktrees, worktreeStatuses }
    this.now = deps.now ?? Date.now
    this.intervals = { ...DEFAULT_INTERVALS, ...deps.intervals }
    this.unwatch = deps.hub.onSubscribe((topic) => this.onSubscribe(topic))
  }

  start(): void {
    if (this.timer || this.stopped) return
    this.timer = setInterval(() => {
      this.lastTick = this.tick().catch((err) => console.warn('git poll tick failed', err))
    }, this.intervals.tickMs)
    this.timer.unref()
  }

  stop(): void {
    this.stopped = true
    clearInterval(this.timer)
    this.timer = undefined
    this.unwatch?.()
    this.unwatch = undefined
  }

  health(): HealthWarning[] {
    return [...this.warnings.values()]
  }

  /** The current warning for the repo at `repoPath`, if any (why refresh() returned false). */
  warning(repoPath: string): HealthWarning | undefined {
    return this.warnings.get(real(repoPath))
  }

  /** Resolves when the most recent scheduled tick has finished (for tests). */
  settled(): Promise<void> {
    return this.lastTick
  }

  /** Starts every read that is due and resolves when they finish. Never rejects. */
  async tick(): Promise<void> {
    const now = this.now()
    const uses = this.repoUses()
    for (const key of this.clocks.keys()) if (!uses.has(key)) this.clocks.delete(key)
    let healthChanged = false
    for (const key of this.warnings.keys()) {
      if (!uses.has(key)) {
        this.warnings.delete(key)
        healthChanged = true
      }
    }
    if (healthChanged) this.announceHealth()

    const jobs: Promise<boolean>[] = []
    for (const [key, use] of uses) {
      const active = use.projectIds.some((id) => this.deps.hub.subscriberCount(projectTopic(id)) > 0)
      let clock = this.clocks.get(key)
      if (!clock) {
        clock = { lastList: NEVER, lastStatus: NEVER }
        this.clocks.set(key, clock)
      }
      const list = now - clock.lastList >= (active ? this.intervals.activeListMs : this.intervals.idleListMs)
      const status = active && now - clock.lastStatus >= this.intervals.activeStatusMs
      if (list) clock.lastList = now
      // Claimed here so a later tick does not start a second read while this one runs.
      if (status) clock.lastStatus = now
      if (list || status) jobs.push(this.refresh(use.path, { list, status }))
    }
    await Promise.allSettled(jobs)
  }

  /**
   * Reads the repo's worktrees into every project using it, after any read of it
   * already in flight. Statuses are read too when asked, or when the list added
   * a row or moved a head; not when this list failed. Never rejects; failures
   * become health warnings.
   *
   * Resolves false when a requested list could not be read (warning() says why),
   * else true. A caller that changes git must run the git command first, then
   * await refresh(), then make its own row edits: a read already in flight
   * returns the old listing, and refresh() waits for a read that starts after it.
   */
  async refresh(repoPath: string, what: { list?: boolean; status?: boolean } = {}): Promise<boolean> {
    const key = real(repoPath)
    const list = what.list ?? true
    let status = what.status ?? false
    let listed = false
    try {
      if (list) {
        const result = await this.runs.run(`list ${key}`, () => this.readList(key))
        if (!result.listed) return false
        listed = true
        status = result.stale || status
      }
      if (status) {
        const clock = this.clocks.get(key)
        if (clock) clock.lastStatus = this.now()
        await this.runs.run(`status ${key}`, () => this.readStatus(key))
      }
      return true
    } catch (err) {
      console.warn(`git poll of ${repoPath} failed`, err)
      return listed || !list
    }
  }

  private onSubscribe(topic: string): void {
    const parsed = parseTopic(topic)
    if (parsed?.kind !== 'project') return
    // Only the first subscriber: later ones join a project that is already polled actively.
    if (this.deps.hub.subscriberCount(projectTopic(parsed.projectId)) !== 1) return
    const project = this.find(parsed.projectId)
    if (!project) return
    for (const repo of project.repositories) {
      const clock = this.clocks.get(real(repo.path))
      if (clock) {
        clock.lastList = NEVER
        clock.lastStatus = NEVER
      }
    }
    // Deferred: this runs inside hub.subscribe(), before the response is written.
    // A deferred tick that fires after stop() does nothing.
    this.lastTick = new Promise<void>((resolve) => setImmediate(resolve))
      .then(() => (this.stopped ? undefined : this.tick()))
      .catch((err) => console.warn('git poll on subscribe failed', err))
  }

  private repoUses(): Map<string, RepoUse> {
    const uses = new Map<string, RepoUse>()
    for (const project of this.deps.projects.all()) {
      for (const repo of project.repositories) {
        const key = real(repo.path)
        const use = uses.get(key) ?? { path: repo.path, projectIds: [] }
        if (!use.projectIds.includes(project.id)) use.projectIds.push(project.id)
        uses.set(key, use)
      }
    }
    return uses
  }

  private find(projectId: string): Project | undefined {
    try {
      return this.deps.projects.require(projectId)
    } catch {
      return undefined
    }
  }

  private repoOf(project: Project, key: string): Repository | undefined {
    return project.repositories.find((r) => real(r.path) === key)
  }

  private async readList(key: string): Promise<ListResult> {
    if (this.stopped) return { listed: false, stale: false }
    const use = this.repoUses().get(key)
    if (!use) return { listed: false, stale: false }
    const registered = this.deps.registry().find((r) => real(r.path) === key)
    if (!registered) {
      const names = use.projectIds.map((id) => this.find(id)?.name ?? id).join(', ')
      this.warn(key, `${use.path} (used by ${names}) is not a registered repo; run \`trek-server add ${use.path}\` on the server`)
      return { listed: false, stale: false }
    }
    let listed: GitWorktreeInfo[]
    try {
      listed = await this.git.listWorktrees(registered.path)
    } catch (err) {
      this.warn(key, `cannot list the worktrees of ${registered.path}: ${(err as Error).message}`)
      return { listed: false, stale: false }
    }
    // stop() may have come while git ran: apply nothing.
    if (this.stopped) return { listed: false, stale: false }
    this.clearWarning(key)
    let stale = false
    for (const projectId of this.repoUses().get(key)?.projectIds ?? []) {
      // One project's failure (say its save throws) must not stop the others.
      try {
        stale = this.applyList(projectId, key, listed) || stale
      } catch (err) {
        console.warn(`applying the worktrees of ${registered.path} to project ${projectId} failed`, err)
      }
    }
    return { listed: true, stale }
  }

  private applyList(projectId: string, key: string, listed: GitWorktreeInfo[]): boolean {
    const project = this.find(projectId)
    const repo = project && this.repoOf(project, key)
    if (!repo) return false
    // A dry run decides whether this write must reach disk.
    const preview = reconcileWorktrees(repo, listed, () => 'preview')
    this.deps.projects.apply(
      projectId,
      (draft) => {
        const target = draft.repositories.find((r) => r.id === repo.id)
        if (target) target.worktrees = reconcileWorktrees(target, listed, this.deps.projects.newId).worktrees
      },
      { persist: preview.membershipChanged }
    )
    return preview.headsChanged
  }

  private async readStatus(key: string): Promise<void> {
    if (this.stopped) return
    const use = this.repoUses().get(key)
    if (!use || !this.deps.registry().some((r) => real(r.path) === key)) return
    // The head each path had when the read started: a list (another coalescer
    // key) may move a head while this read runs, and these numbers are not its.
    const heads = new Map<string, string | undefined>()
    const paths: string[] = []
    for (const projectId of use.projectIds) {
      const project = this.find(projectId)
      const repo = project && this.repoOf(project, key)
      for (const w of repo?.worktrees ?? []) {
        if (w.missing || heads.has(real(w.path))) continue
        heads.set(real(w.path), w.head)
        paths.push(w.path)
      }
    }
    if (paths.length === 0) return
    const statuses = await this.git.worktreeStatuses(paths)
    if (this.stopped) return
    for (const projectId of this.repoUses().get(key)?.projectIds ?? []) {
      if (!this.find(projectId)) continue
      try {
        this.deps.projects.apply(
          projectId,
          (draft) => {
            for (const r of draft.repositories) {
              if (real(r.path) !== key) continue
              const current = new Map(r.worktrees.map((w) => [real(w.path), w.head]))
              const fresh = statuses.filter((st) => {
                const path = real(st.path)
                return heads.has(path) && current.has(path) && current.get(path) === heads.get(path)
              })
              r.worktrees = applyStatuses(r.worktrees, fresh)
            }
          },
          { persist: false }
        )
      } catch (err) {
        console.warn(`applying worktree statuses to project ${projectId} failed`, err)
      }
    }
  }

  /** Tells the listener health() changed; a throwing listener is logged, not raised. */
  private announceHealth(): void {
    try {
      this.deps.onHealth()
    } catch (err) {
      console.warn('git poller health listener failed', err)
    }
  }

  private warn(key: string, message: string): void {
    const previous = this.warnings.get(key)
    if (previous?.message === message) return
    this.warnings.set(key, { code: 'REPO_UNAVAILABLE', message, since: previous?.since ?? this.now() })
    this.announceHealth()
  }

  private clearWarning(key: string): void {
    if (this.warnings.delete(key)) this.announceHealth()
  }
}
