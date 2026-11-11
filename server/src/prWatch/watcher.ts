// The pull request watch (phase 5c-1): every few minutes the server asks gh about each watched
// branch's linked PR, compares it with the last poll (src/shared/prWatch.ts) and reports what changed:
// a prompt queued on the worktree's newest agent session, and a notice on the worktree that the
// `attention` topic lists. Nothing starts a session. A watch is the branch's `prWatch` field: it
// is saved with the project, so it survives a restart, and its `seen` keeps a restart from reporting
// anything twice. Merged or closed is reported, then the watch turns itself off.
import type { PrNotice, Project, Repository, Worktree } from '../../../src/shared/model/types'
import {
  noticeText,
  parsePrView,
  prQueryArgs,
  promptText,
  watchStep,
  watchableUrl,
  type PrEvent,
  type PrView,
  type PromptOutcome
} from '../../../src/shared/prWatch.ts'
import type { ProjectState } from '../projects/state.ts'
import { MAX_QUEUE_LENGTH } from '../sessions/limits.ts'
import { ghSignedIn, isAuthFailure, type GhRunner } from './gh.ts'

/** Between rounds of polls */
export const PR_POLL_MS = 3 * 60_000
/** Between sign-in checks (`gh auth status`), signed in or not */
export const GH_RECHECK_MS = 10 * 60_000
/** `ready` waits at most this long for the first check: a slow gh never holds up the server's start */
export const GH_READY_MS = 3000
/** Failed polls in a row before the worktree gets a "can't be read" notice */
export const FAILS_BEFORE_NOTICE = 3
/** A failure's reason in that notice is cut to this many characters */
const MAX_REASON = 120

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
  /** The SessionManager's: queues a prompt (throws when the queue is full or the session is gone), and republishes `attention` */
  sessions: {
    enqueue(p: { projectId: string; sessionId: string; text: string }): unknown
    refreshAttention(): void
  }
  gh: GhRunner
  /** gh's sign-in changed: the server tells every connection (`integrations.changed` `{prWatch}`) */
  onAvailability?: (available: boolean) => void
  /** A round found something to report (its notice is set): the push (6b) */
  onReport?: (p: { projectId: string; projectName: string; worktreeId: string; events: readonly PrEvent[] }) => void
  pollMs?: number
  recheckMs?: number
  now?: () => number
  schedule?: (fn: () => void | Promise<void>, ms: number) => ScheduledJob
}

/** One watched branch, as a round found it. */
export interface Target {
  projectId: string
  repoId: string
  branch: string
  url: string
  number: number
  owner: string
  repo: string
}

/** A poll's identity: the URL too, so a PR re-linked mid-poll gets its own (baseline) poll at once. */
const keyOf = (t: Target): string => JSON.stringify([t.projectId, t.repoId, t.branch, t.url])

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
        if (pr) out.push({ projectId: project.id, repoId: repo.id, branch, ...pr })
      }
    }
  }
  return out
}

/** The first line of a failure, cut short, for a notice. */
function shortReason(message: string): string {
  const line = message.split('\n')[0].trim() || 'gh failed'
  return line.length > MAX_REASON ? `${line.slice(0, MAX_REASON - 1)}…` : line
}

export class PrWatcher {
  private readonly deps: PrWatcherDeps
  private readonly now: () => number
  private readonly schedule: NonNullable<PrWatcherDeps['schedule']>
  private signedIn = false
  /** The sign-in check running now: every caller meanwhile shares it, so one change is told once */
  private signInCheck: Promise<boolean> | undefined
  private pollJob: ScheduledJob | undefined
  private recheckJob: ScheduledJob | undefined
  private stopped = false
  /** Aborted by stop(): kills any gh still running */
  private readonly abort = new AbortController()
  /** Polls running now (keyOf): a poll asked for meanwhile is skipped */
  private readonly inFlight = new Set<string>()
  /** The last failure logged per poll key, so a lasting one is logged once */
  private readonly lastError = new Map<string, string>()
  /** Failed polls in a row per key */
  private readonly failures = new Map<string, number>()
  /** The "can't be read" notice raised per key (its `at`), withdrawn by the next good poll */
  private readonly unreadable = new Map<string, number>()
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
    void this.firstCheck.then(() => {
      this.nextRound()
      this.nextRecheck()
    })
  }

  stop(): void {
    this.stopped = true
    this.pollJob?.cancel()
    this.recheckJob?.cancel()
    this.abort.abort()
  }

  /** A watch was turned on (or its PR changed): poll it now rather than at the next round. */
  pollSoon(projectId: string, repoId: string, branch: string): void {
    const target = watchTargets([this.deps.projects.require(projectId)]).find((t) => t.repoId === repoId && t.branch === branch)
    if (target && this.signedIn) void this.poll(target)
  }

  /**
   * A branch's watch ended (turned off, its PR changed, or merged): its failure count, logged
   * failure and "can't be read" mark go, so a watch turned back on counts afresh and can raise a
   * new notice.
   */
  forget(projectId: string, repoId: string, branch: string): void {
    this.forgetKeys((key) => {
      const [p, r, b] = JSON.parse(key) as string[]
      return p === projectId && r === repoId && b === branch
    })
  }

  private forgetKeys(drop: (key: string) => boolean): void {
    for (const map of [this.failures, this.lastError, this.unreadable]) {
      for (const key of [...map.keys()]) if (drop(key)) map.delete(key)
    }
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

  /**
   * Asks `gh auth status`, and tells onAvailability when the answer changed. It runs at start, every
   * GH_RECHECK_MS signed in or not (so a sign-out is noticed with nothing watched), and after a poll
   * fails in a way that looks like gh's sign-in. Callers while one runs share it.
   */
  checkSignIn(): Promise<boolean> {
    if (this.stopped) return Promise.resolve(this.signedIn)
    this.signInCheck ??= this.askSignIn().finally(() => (this.signInCheck = undefined))
    return this.signInCheck
  }

  private async askSignIn(): Promise<boolean> {
    const now = await ghSignedIn(this.deps.gh, this.abort.signal)
    if (this.stopped) return this.signedIn
    if (now !== this.signedIn) {
      this.signedIn = now
      this.deps.onAvailability?.(now)
      console.log(now ? '[prWatch] gh is signed in: pull requests can be watched' : '[prWatch] gh is not installed or not signed in: pull requests are not watched')
    }
    return now
  }

  private nextRound(): void {
    if (this.stopped) return
    this.pollJob = this.schedule(() => this.round(), this.deps.pollMs ?? PR_POLL_MS)
  }

  private nextRecheck(): void {
    if (this.stopped) return
    this.recheckJob = this.schedule(async () => {
      try {
        await this.checkSignIn()
      } finally {
        this.nextRecheck()
      }
    }, this.deps.recheckMs ?? GH_RECHECK_MS)
  }

  /**
   * One round: forgets what unwatchable branches saw (and the failures of branches no longer
   * watched, however their watch ended), then polls every watched branch, one at a time.
   */
  async round(): Promise<void> {
    try {
      this.forgetUnpolled()
      const targets = watchTargets(this.deps.projects.all())
      const live = new Set(targets.map(keyOf))
      this.forgetKeys((key) => !live.has(key) && !this.inFlight.has(key))
      if (!this.signedIn) return
      for (const target of targets) {
        if (this.stopped) return
        try {
          await this.poll(target)
        } catch (err) {
          console.warn(`[prWatch] polling ${target.url} failed: ${(err as Error).message}`)
        }
      }
    } catch (err) {
      console.warn(`[prWatch] a round failed: ${(err as Error).message}`)
    } finally {
      this.nextRound()
    }
  }

  /**
   * A watched branch with no worktree (removed, or missing from disk) is not polled; its `seen`
   * is dropped, so when a worktree has it again the next poll is a fresh baseline rather than a
   * report of everything that happened meanwhile.
   */
  private forgetUnpolled(): void {
    for (const project of this.deps.projects.all()) {
      const stale = project.repositories.some((r) => Object.entries(r.branchData).some(([b, d]) => d.prWatch?.seen && !worktreeOn(r, b)))
      if (!stale) continue
      this.deps.projects.apply(project.id, (d) => {
        for (const r of d.repositories) {
          for (const [b, data] of Object.entries(r.branchData)) if (data.prWatch?.seen && !worktreeOn(r, b)) data.prWatch = {}
        }
      })
    }
  }

  /**
   * Asks gh about one PR and applies what changed. A failure is logged (once while it lasts), the
   * watch stays as it was, and the sign-in is re-checked only when the failure looks like gh's
   * sign-in (a network blip or one unreadable PR leaves the capability alone). FAILS_BEFORE_NOTICE
   * failures in a row raise a "can't be read" notice on the worktree, once, until a poll succeeds.
   */
  async poll(target: Target): Promise<void> {
    const key = keyOf(target)
    if (this.inFlight.has(key) || this.stopped) return
    this.inFlight.add(key)
    try {
      let view: PrView
      try {
        const stdout = await this.deps.gh(prQueryArgs(target), this.abort.signal)
        if (this.stopped) return
        view = parsePrView(JSON.parse(stdout))
      } catch (err) {
        if (this.stopped) return
        const message = (err as Error).message
        this.failed(target, key, message)
        if (isAuthFailure(message)) await this.checkSignIn()
        return
      }
      this.lastError.delete(key)
      this.failures.delete(key)
      this.apply(target, key, view)
    } finally {
      this.inFlight.delete(key)
    }
  }

  private failed(target: Target, key: string, message: string): void {
    if (this.lastError.get(key) !== message) {
      this.lastError.set(key, message)
      console.warn(`[prWatch] reading ${target.url}: ${message}`)
    }
    const count = (this.failures.get(key) ?? 0) + 1
    this.failures.set(key, count)
    if (count !== FAILS_BEFORE_NOTICE) return
    const worktree = this.worktreeOf(target)
    if (!worktree) return
    const notice: PrNotice = { title: `PR #${target.number}`, text: `Can’t be read: ${shortReason(message)}`, url: target.url, at: this.now() }
    if (this.setNotice(target, worktree.id, notice)) this.unreadable.set(key, notice.at)
  }

  private worktreeOf(target: Target): Worktree | undefined {
    try {
      const repo = this.deps.projects.require(target.projectId).repositories.find((r) => r.id === target.repoId)
      return repo && worktreeOn(repo, target.branch)
    } catch {
      return undefined // the project is gone
    }
  }

  /** Sets (or, with undefined, clears) a worktree's notice and republishes `attention`; false if the project is gone. */
  private setNotice(target: Target, worktreeId: string, notice: PrNotice | undefined, only?: (current: PrNotice | undefined) => boolean): boolean {
    try {
      this.deps.projects.apply(
        target.projectId,
        (d) => {
          for (const r of d.repositories) {
            for (const w of r.worktrees) {
              if (w.id !== worktreeId || (only && !only(w.prNotice))) continue
              if (notice) w.prNotice = notice
              else delete w.prNotice
            }
          }
        },
        { persist: false }
      )
    } catch {
      return false
    }
    this.deps.sessions.refreshAttention()
    return true
  }

  /**
   * Re-reads the branch after the await: a watch turned off, a PR changed, or the worktree gone
   * meanwhile is left alone (its `seen` does not move, so nothing is lost; the next round's
   * forgetUnpolled drops it if the worktree stays gone).
   */
  private apply(target: Target, key: string, view: PrView): void {
    const unreadableAt = this.unreadable.get(key)
    if (unreadableAt !== undefined) {
      this.unreadable.delete(key)
      const worktree = this.worktreeOf(target)
      // Readable again: the "can't be read" notice goes, unless something replaced it.
      if (worktree) this.setNotice(target, worktree.id, undefined, (n) => n?.at === unreadableAt && n.url === target.url)
    }
    let events: PrEvent[] = []
    try {
      events = this.deps.projects.apply(target.projectId, (d) => {
        const repo = d.repositories.find((r) => r.id === target.repoId)
        const data = repo && Object.hasOwn(repo.branchData, target.branch) ? repo.branchData[target.branch] : undefined
        if (!repo || !data?.prWatch || data.pr !== target.url || !worktreeOn(repo, target.branch)) return []
        const step = watchStep(data.prWatch.seen, view)
        if (step.stop) {
          delete data.prWatch
          this.forgetKeys((k) => k === key)
        } else data.prWatch = { seen: step.seen }
        return step.events
      })
    } catch {
      return // the project is gone
    }
    if (events.length > 0) this.report(target, events)
  }

  /**
   * Queues the prompt on the worktree's newest session, and sets the worktree's notice. The newest
   * session's full queue is reported as such (the prompt is not moved to another session); a
   * session that refuses it otherwise (closed meanwhile) passes it to the next newest. With none
   * left, the notice alone reports it.
   */
  private report(target: Target, events: PrEvent[]): void {
    // apply() ran in this same tick and found the worktree; this guard only covers a future await.
    const worktree = this.worktreeOf(target)
    if (!worktree) return
    const text = promptText(target.url, target.number, events)
    let outcome: PromptOutcome = 'noSession'
    // Sessions are kept in the order they were started; every v2 session runs an agent.
    for (const session of [...worktree.sessions].reverse()) {
      if (session.queue.length >= MAX_QUEUE_LENGTH) {
        outcome = 'queueFull'
        break
      }
      try {
        this.deps.sessions.enqueue({ projectId: target.projectId, sessionId: session.id, text })
        outcome = { queuedFor: session.title }
        break
      } catch (err) {
        console.warn(`[prWatch] could not queue the prompt for ${target.url} on ${session.title}: ${(err as Error).message}`)
      }
    }
    this.setNotice(target, worktree.id, { title: `PR #${target.number}`, text: noticeText(events, outcome), url: target.url, at: this.now() })
    try {
      const projectName = [...this.deps.projects.all()].find((p) => p.id === target.projectId)?.name ?? ''
      this.deps.onReport?.({ projectId: target.projectId, projectName, worktreeId: worktree.id, events })
    } catch (err) {
      console.warn('[prWatch] onReport failed', err)
    }
  }
}
