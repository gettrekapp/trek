// promote_to_primary's confirmation (phase 5e). A window that can confirm says so for its project
// (`promote.listen`); the tool asks those windows (`promote.request`, only to the listeners still
// subscribed to the project's topic), and:
//
// - a window whose user confirms claims the request first (`promote.claim`, before any teardown):
//   the first claim wins; every subscriber hears `promote.settled {claimed: true}` (the others
//   close their dialog), and the window-count check and the answer timeout stop. The claimant then
//   sends `worktree.promote {requestId}`, whose own result settles the request (`bind`); a claim
//   with no promote within PROMOTE_CLAIM_TIMEOUT_MS, or whose window goes away first, fails;
// - a decline (`promote.answer {outcome: 'declined'}`) settles it while nobody has claimed it.
//
// One request per worktree at a time: a second call for it joins the first and gets its outcome.
// The callers going away (their MCP calls dropped) cancels a request only while it is unclaimed:
// once a window runs the promote, it settles as the promote does.
import { randomUUID } from 'node:crypto'
import { projectTopic } from '../../../src/shared/model/topics.ts'
import {
  PROMOTE_ANSWER_TIMEOUT_MS,
  PROMOTE_CLAIM_TIMEOUT_MS,
  PROMOTE_WINDOW_CHECK_MS,
  type PromoteOutcome,
  type PromoteRequestEvent,
  type PromoteSettledEvent
} from '../../../src/shared/promote.ts'
import { codedError } from '../errors.ts'
import type { Subscriber, TopicHub } from '../topicHub.ts'

/** How a request ended, besides a window's answer. */
export type PromoteAsk = PromoteOutcome | { outcome: 'no-window' } | { outcome: 'timeout' } | { outcome: 'cancelled' }

interface Pending {
  projectId: string
  worktreeId: string
  promise: Promise<PromoteAsk>
  settle: (result: PromoteAsk) => void
  /** Tool calls waiting on it that have not gone away */
  callers: number
  /** The window that confirmed it */
  claimant?: Subscriber
  /** Its claimant's worktree.promote is running */
  started: boolean
  /** Stops the answer timeout and window check (on a claim) */
  stopWaiting: () => void
  claimTimer?: NodeJS.Timeout
}

export interface PromoteRequestsOptions {
  timeoutMs?: number
  checkMs?: number
  claimMs?: number
}

/** A claimed request bound to the claimant's worktree.promote: `settle` ends it with the promote's result. */
export interface PromoteBinding {
  settle(outcome: PromoteOutcome): void
}

export class PromoteRequests {
  private readonly pending = new Map<string, Pending>()
  /** `${projectId}\0${worktreeId}` → its pending request */
  private readonly byWorktree = new Map<string, string>()
  /** projectId → the connections that can confirm (promote.listen) */
  private readonly listeners = new Map<string, Set<Subscriber>>()
  private readonly hub: TopicHub
  private readonly timeoutMs: number
  private readonly checkMs: number
  private readonly claimMs: number

  constructor(hub: TopicHub, options: PromoteRequestsOptions = {}) {
    this.hub = hub
    this.timeoutMs = options.timeoutMs ?? PROMOTE_ANSWER_TIMEOUT_MS
    this.checkMs = options.checkMs ?? PROMOTE_WINDOW_CHECK_MS
    this.claimMs = options.claimMs ?? PROMOTE_CLAIM_TIMEOUT_MS
  }

  /** `promote.listen`: this connection can confirm the project's requests (or no longer can). */
  listen(projectId: string, subscriber: Subscriber, on = true): void {
    let set = this.listeners.get(projectId)
    if (on) {
      if (!set) this.listeners.set(projectId, (set = new Set()))
      set.add(subscriber)
    } else if (set) {
      set.delete(subscriber)
      if (set.size === 0) this.listeners.delete(projectId)
    }
  }

  /** A connection closed: it listens no more, and a claim it holds without a promote running fails. */
  forget(subscriber: Subscriber): void {
    for (const [projectId, set] of [...this.listeners]) {
      set.delete(subscriber)
      if (set.size === 0) this.listeners.delete(projectId)
    }
    for (const p of [...this.pending.values()]) {
      if (p.claimant === subscriber && !p.started) {
        p.settle({ outcome: 'failed', error: 'the window that confirmed the promote went away before it started; nothing was changed' })
      }
    }
  }

  /** The connections that would get a request now: listeners still subscribed to the project's topic. */
  private reachable(projectId: string): Subscriber[] {
    const topic = projectTopic(projectId)
    return [...(this.listeners.get(projectId) ?? [])].filter((s) => s.event && this.hub.isSubscribed(topic, s))
  }

  /** How many windows could confirm the project's requests now. */
  windows(projectId: string): number {
    return this.reachable(projectId).length
  }

  /**
   * Asks the project's windows; resolves with the outcome, or `no-window` (none can confirm, now
   * or any more, before one claims it), `timeout` (nobody claimed or declined in time), or
   * `cancelled` (every caller went away before a window claimed it). A request for a worktree
   * that already has one joins it.
   */
  ask(projectId: string, request: Omit<PromoteRequestEvent, 'projectId' | 'requestId'>, signal?: AbortSignal): Promise<PromoteAsk> {
    const key = `${projectId}\0${request.worktreeId}`
    const joined = this.byWorktree.get(key)
    const existing = joined === undefined ? undefined : this.pending.get(joined)
    if (existing) {
      this.follow(existing, signal)
      return existing.promise
    }
    if (this.windows(projectId) === 0) return Promise.resolve({ outcome: 'no-window' })
    const requestId = randomUUID()
    let settle!: (result: PromoteAsk) => void
    const promise = new Promise<PromoteAsk>((resolve) => {
      let done = false
      settle = (result: PromoteAsk): void => {
        if (done) return
        done = true
        entry.stopWaiting()
        clearTimeout(entry.claimTimer)
        this.pending.delete(requestId)
        if (this.byWorktree.get(key) === requestId) this.byWorktree.delete(key)
        this.hub.emit(projectTopic(projectId), 'promote.settled', { projectId, requestId } satisfies PromoteSettledEvent)
        resolve(result)
      }
    })
    const timer = setTimeout(() => entry.settle({ outcome: 'timeout' }), this.timeoutMs)
    timer.unref?.()
    const check = setInterval(() => {
      if (this.windows(projectId) === 0) entry.settle({ outcome: 'no-window' })
    }, this.checkMs)
    check.unref?.()
    const entry: Pending = {
      projectId,
      worktreeId: request.worktreeId,
      promise,
      settle,
      callers: 0,
      started: false,
      stopWaiting: () => {
        clearTimeout(timer)
        clearInterval(check)
      }
    }
    this.pending.set(requestId, entry)
    this.byWorktree.set(key, requestId)
    this.follow(entry, signal)
    if (this.pending.has(requestId)) {
      const payload = { projectId, requestId, ...request } satisfies PromoteRequestEvent
      let json: string | undefined
      const frame = (): string => (json ??= JSON.stringify({ type: 'event', event: 'promote.request', payload }))
      let sent = 0
      for (const s of this.reachable(projectId)) {
        try {
          if (s.event!('promote.request', payload, frame)) sent += 1
        } catch (err) {
          console.warn('sending promote.request to a window failed', err)
        }
      }
      if (sent === 0) entry.settle({ outcome: 'no-window' })
    }
    return promise
  }

  /** One more caller waits on `p`; once every caller has gone away an unclaimed request is cancelled. */
  private follow(p: Pending, signal?: AbortSignal): void {
    p.callers += 1
    if (!signal) return
    const onAbort = (): void => {
      p.callers -= 1
      if (p.callers <= 0 && !p.claimant) p.settle({ outcome: 'cancelled' })
    }
    if (signal.aborted) onAbort()
    else {
      signal.addEventListener('abort', onAbort, { once: true })
      void p.promise.then(() => signal.removeEventListener('abort', onAbort))
    }
  }

  private find(projectId: string, requestId: string): Pending | undefined {
    const p = this.pending.get(requestId)
    return p && p.projectId === projectId ? p : undefined
  }

  /** Claims `p` for `subscriber`: the other windows close their dialog; the claimant has claimMs to start the promote. */
  private take(p: Pending, requestId: string, subscriber: Subscriber): void {
    p.claimant = subscriber
    p.stopWaiting()
    p.claimTimer = setTimeout(() => {
      if (!p.started) p.settle({ outcome: 'failed', error: 'the window that confirmed the promote did not start it in time; nothing was changed' })
    }, this.claimMs)
    p.claimTimer.unref?.()
    this.hub.emit(projectTopic(p.projectId), 'promote.settled', { projectId: p.projectId, requestId, claimed: true } satisfies PromoteSettledEvent)
  }

  /** `promote.claim`: the first window to confirm; false when unknown, ended, or claimed already. */
  claim(projectId: string, requestId: string, subscriber: Subscriber): boolean {
    const p = this.find(projectId, requestId)
    if (!p || p.claimant) return false
    this.take(p, requestId, subscriber)
    return true
  }

  /**
   * `promote.answer`: `declined` while nobody has claimed it (or by its claimant before its promote
   * starts); `failed` only by its claimant before its promote starts (a teardown that failed).
   * False otherwise.
   */
  answer(projectId: string, requestId: string, outcome: Exclude<PromoteOutcome, { outcome: 'promoted' }>, subscriber: Subscriber): boolean {
    const p = this.find(projectId, requestId)
    if (!p || p.started) return false
    if (p.claimant ? p.claimant !== subscriber : outcome.outcome !== 'declined') return false
    p.settle(outcome)
    return true
  }

  /**
   * `worktree.promote {requestId}`: binds the request to this promote (claiming it, if this window
   * had not); its result settles it. NOT_FOUND for an unknown or ended request, BAD_REQUEST for
   * another worktree's, CONFLICT when another window claimed it or its promote already runs.
   */
  bind(projectId: string, requestId: string, worktreeId: string, subscriber: Subscriber): PromoteBinding {
    const p = this.find(projectId, requestId)
    if (!p) throw codedError('NOT_FOUND', 'No such promote request (it was answered, it ended, or the server restarted since)')
    if (p.worktreeId !== worktreeId) throw codedError('BAD_REQUEST', 'that promote request is for another worktree')
    if (p.started || (p.claimant && p.claimant !== subscriber)) throw codedError('CONFLICT', 'another window is running that promote')
    if (!p.claimant) this.take(p, requestId, subscriber)
    p.started = true
    clearTimeout(p.claimTimer)
    return { settle: (outcome) => p.settle(outcome) }
  }

  /** Server shutdown: every waiting tool call ends. */
  stop(): void {
    for (const p of [...this.pending.values()]) p.settle({ outcome: 'cancelled' })
  }
}
