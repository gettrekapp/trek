// The pull request watch (phase 5c-1): every few minutes the server asks gh about each watched
// branch's linked PR, compares it with the last poll (src/shared/prWatch.ts) and reports what changed:
// a prompt queued on the worktree's newest agent session, and a notice on the worktree that the
// `attention` topic lists. Nothing starts a session. A watch is the branch's `prWatch` field: it
// is saved with the project, so it survives a restart, and its `seen` keeps a restart from reporting
// anything twice. Merged or closed is reported, then the watch turns itself off.
import type { Project, Repository, Worktree } from '../../../src/shared/model/types'
import {
  PR_VIEW_FIELDS,
  noticeText,
  parsePrView,
  promptText,
  watchStep,
  watchableUrl,
  type PrEvent,
  type PromptOutcome
} from '../../../src/shared/prWatch.ts'
import type { ProjectState } from '../projects/state.ts'
import { MAX_QUEUE_LENGTH } from '../sessions/limits.ts'
import { ghSignedIn, type GhRunner } from './gh.ts'

/** Between rounds of polls */
export const PR_POLL_MS = 3 * 60_000
/** How often a server whose gh is not signed in looks again */
export const GH_RECHECK_MS = 10 * 60_000
/** `ready` waits at most this long for the first check: a slow gh never holds up the server's start */
export const GH_READY_MS = 3000

/**
 * `TREK_SERVER_PR_POLL_MS` from the server's environment, for the smokes: a whole number of
 * milliseconds, at least 1000. Anything else (or none) is the default.
 */
export function pollMsFromEnv(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+$/.test(value)) return undefined
  const ms = Number(value)
  return ms >= 1000 ? ms : undefined
}

export interface ScheduledJob {
  cancel(): void
}

export interface PrWatcherDeps {
  projects: ProjectState
  /** The SessionManager's: queues a prompt (throws when the queue is full), and republishes `attention` */
  sessions: {
    enqueue(p: { projectId: string; sessionId: string; text: string }): unknown
    refreshAttention(): void
  }
  gh: GhRunner
  /** gh's sign-in changed: the server tells every connection (`integrations.changed` `{prWatch}`) */
  onAvailability?: (available: boolean) => void
  pollMs?: number
  recheckMs?: number
  now?: () => number
  schedule?: (fn: () => void | Promise<void>, ms: number) => ScheduledJob
}

/** One watched branch, as a round found it. */
interface Target {
  projectId: string
  repoId: string
  branch: string
  url: string
  number: number
}

const keyOf = (t: { projectId: string; repoId: string; branch: string }): string => JSON.stringify([t.projectId, t.repoId, t.branch])

/** The worktree that has `branch` checked out (and is still on disk). */
function worktreeOn(repo: Repository, branch: string): Worktree | undefined {
  return repo.worktrees.find((w) => w.branch === branch && !w.missing)
}

/** Every watched branch checked out in a worktree, with a URL gh may be given. */
export function watchTargets(projects: Iterable<Project>): Target[] {
  const out: Target[] = []
  for (const project of projects) {
    for (const repo of project.repositories) {
      for (const [branch, data] of Object.entries(repo.branchData)) {
        if (!data.prWatch || !worktreeOn(repo, branch)) continue
        const pr = watchableUrl(data.pr)
        if (pr) out.push({ projectId: project.id, repoId: repo.id, branch, url: pr.url, number: pr.number })
      }
    }
  }
  return out
}

export class PrWatcher {
  private readonly deps: PrWatcherDeps
  private readonly now: () => number
  private readonly schedule: NonNullable<PrWatcherDeps['schedule']>
  private signedIn = false
  private lastCheck = -Infinity
  private job: ScheduledJob | undefined
  private stopped = false
  /** Branches being polled now: a poll asked for meanwhile is skipped */
  private readonly inFlight = new Set<string>()
  /** The last failure logged per branch, so a lasting one is logged once */
  private readonly lastError = new Map<string, string>()
  /** Settles once the first `gh auth status` has answered, or after GH_READY_MS; never rejects */
  readonly ready: Promise<void>
  private readonly firstCheck: Promise<boolean>

  constructor(deps: PrWatcherDeps) {
    this.deps = deps
    this.now = deps.now ?? Date.now
    this.schedule =
      deps.schedule ??
      ((fn, ms) => {
        const timer = setTimeout(() => void fn(), ms)
        timer.unref()
        return { cancel: () => clearTimeout(timer) }
      })
    this.firstCheck = this.checkSignIn()
    this.ready = Promise.race([
      this.firstCheck.then(() => undefined),
      new Promise<void>((resolve) => setTimeout(resolve, GH_READY_MS).unref())
    ])
  }

  /** gh is installed and signed in (as of the last check): the welcome lists `prWatch` */
  available(): boolean {
    return this.signedIn
  }

  start(): void {
    void this.firstCheck.then(() => this.next())
  }

  stop(): void {
    this.stopped = true
    this.job?.cancel()
  }

  /** A watch was turned on (or its PR changed): poll it now rather than at the next round. */
  pollSoon(projectId: string, repoId: string, branch: string): void {
    const target = watchTargets([this.deps.projects.require(projectId)]).find((t) => t.repoId === repoId && t.branch === branch)
    if (target && this.signedIn) void this.poll(target)
  }

  /** Clears a worktree's notice (`prWatch.dismiss`). */
  dismiss(projectId: unknown, worktreeId: string): void {
    this.deps.projects.apply(
      projectId,
      (d) => {
        for (const r of d.repositories) for (const w of r.worktrees) if (w.id === worktreeId) delete w.prNotice
      },
      { persist: false }
    )
    this.deps.sessions.refreshAttention()
  }

  private async checkSignIn(): Promise<boolean> {
    this.lastCheck = this.now()
    const was = this.signedIn
    this.signedIn = await ghSignedIn(this.deps.gh)
    if (this.signedIn !== was) {
      this.deps.onAvailability?.(this.signedIn)
      console.log(this.signedIn ? '[prWatch] gh is signed in: pull requests can be watched' : '[prWatch] gh is not installed or not signed in: pull requests are not watched')
    }
    return this.signedIn
  }

  private next(): void {
    if (this.stopped) return
    this.job = this.schedule(() => this.round(), this.deps.pollMs ?? PR_POLL_MS)
  }

  /** One round: every watched branch, one at a time. */
  async round(): Promise<void> {
    try {
      if (!this.signedIn && this.now() - this.lastCheck >= (this.deps.recheckMs ?? GH_RECHECK_MS)) await this.checkSignIn()
      if (!this.signedIn) return
      for (const target of watchTargets(this.deps.projects.all())) {
        if (this.stopped) return
        await this.poll(target)
      }
    } catch (err) {
      console.warn(`[prWatch] a round failed: ${(err as Error).message}`)
    } finally {
      this.next()
    }
  }

  /** Asks gh about one PR and applies what changed; a failure is logged (once while it lasts) and the watch stays. */
  async poll(target: Target): Promise<void> {
    const key = keyOf(target)
    if (this.inFlight.has(key)) return
    this.inFlight.add(key)
    try {
      let stdout: string
      try {
        stdout = await this.deps.gh(['pr', 'view', target.url, '--json', PR_VIEW_FIELDS])
      } catch (err) {
        this.logOnce(key, `gh pr view ${target.url}: ${(err as Error).message}`)
        // Signed out meanwhile: stop asking until the next check finds it signed in.
        await this.checkSignIn()
        return
      }
      let view
      try {
        view = parsePrView(JSON.parse(stdout))
      } catch (err) {
        this.logOnce(key, `gh pr view ${target.url}: ${(err as Error).message}`)
        return
      }
      this.lastError.delete(key)
      if (this.stopped) return
      this.apply(target, view)
    } finally {
      this.inFlight.delete(key)
    }
  }

  private logOnce(key: string, message: string): void {
    if (this.lastError.get(key) === message) return
    this.lastError.set(key, message)
    console.warn(`[prWatch] ${message}`)
  }

  /** Re-reads the branch after the await: a watch turned off, or a PR changed, meanwhile is left alone. */
  private apply(target: Target, view: ReturnType<typeof parsePrView>): void {
    let events: PrEvent[] = []
    try {
      events = this.deps.projects.apply(target.projectId, (d) => {
        const repo = d.repositories.find((r) => r.id === target.repoId)
        const data = repo && Object.hasOwn(repo.branchData, target.branch) ? repo.branchData[target.branch] : undefined
        if (!repo || !data?.prWatch || data.pr !== target.url) return []
        const step = watchStep(data.prWatch.seen, view)
        if (step.stop) delete data.prWatch
        else data.prWatch = { seen: step.seen }
        return step.events
      })
    } catch {
      return // the project is gone
    }
    if (events.length > 0) this.report(target, events)
  }

  /** Queues the prompt on the worktree's newest session, if any, and sets the worktree's notice. */
  private report(target: Target, events: PrEvent[]): void {
    const project = this.deps.projects.require(target.projectId)
    const repo = project.repositories.find((r) => r.id === target.repoId)
    const worktree = repo && worktreeOn(repo, target.branch)
    if (!worktree) return
    // Sessions are kept in the order they were started; every v2 session runs an agent.
    const session = worktree.sessions.at(-1)
    let outcome: PromptOutcome = 'noSession'
    if (session) {
      if (session.queue.length >= MAX_QUEUE_LENGTH) outcome = 'queueFull'
      else {
        try {
          this.deps.sessions.enqueue({ projectId: target.projectId, sessionId: session.id, text: promptText(target.url, target.number, events) })
          outcome = { queuedFor: session.title }
        } catch (err) {
          console.warn(`[prWatch] could not queue the prompt for ${target.url}: ${(err as Error).message}`)
          outcome = 'queueFull'
        }
      }
    }
    const notice = { title: `PR #${target.number}`, text: noticeText(events, outcome), url: target.url, at: this.now() }
    try {
      this.deps.projects.apply(
        target.projectId,
        (d) => {
          for (const r of d.repositories) for (const w of r.worktrees) if (w.id === worktree.id) w.prNotice = notice
        },
        { persist: false }
      )
    } catch {
      return
    }
    this.deps.sessions.refreshAttention()
  }
}
