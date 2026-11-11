// Background push (6b): what the server sends to a phone's relay, and when. It follows the
// `attention` topic (a decision asked, a session waiting for the user) and hears session exits and
// pull request reports directly. For each phone grant that wants that kind, isn't paused, and whose
// token has no live connection (the app shows it already), it posts the kind, the project's name
// and the ids to the relay. One push per (token, project, kind) in 30 seconds; network errors and
// 5xx are retried (3 times, backing off); a 401/404/410 means the grant is gone, so it is dropped.
import type { AttentionEntry } from '../../../src/shared/model/types.ts'
import type { AttentionTopic } from '../../../src/shared/model/topics.ts'
import type { PrEvent } from '../../../src/shared/prWatch.ts'
import { pushGroupOf, type PushData, type PushKind, type RelayPushBody } from '../../../src/shared/push.ts'
import { applyPatch, type PatchOp } from '../../../src/shared/sync/jsonPatch.ts'
import type { Subscriber, TopicHub } from '../topicHub.ts'
import type { PushGrants } from './grants.ts'

export const COALESCE_MS = 30_000
export const PUSH_RETRIES = 3
const BACKOFF_MS = [1_000, 3_000, 10_000]
const POST_TIMEOUT_MS = 10_000

export interface PushEvent {
  kind: PushKind
  projectId: string
  projectName: string
  worktreeId?: string | null
  sessionId?: string
}

export interface PusherDeps {
  hub: TopicHub
  grants: PushGrants
  /** Whether any connection signed in with this token is open now */
  isConnected(tokenName: string): boolean
  serverId(): string
  fetch?: typeof fetch
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  log?: (line: string) => void
}

/** The kind a pull request report pushes as: the most pressing of its events, or none */
export function prPushKind(events: readonly PrEvent[]): PushKind | undefined {
  const has = (k: PrEvent['kind']): boolean => events.some((e) => e.kind === k)
  if (has('conflict')) return 'pr-conflict'
  if (has('checksFailed')) return 'pr-checks-failed'
  if (has('comments')) return 'pr-review'
  if (has('merged')) return 'pr-merged'
  if (has('closed')) return 'pr-closed'
  if (has('checksPassed')) return 'pr-checks-passed'
  return undefined
}

/** A session entry's identity for "is this new": a decision by when it was asked, a waiting session by since */
function entryKey(e: AttentionEntry): { key: string; kind: PushKind } | undefined {
  if (!e.sessionId) return undefined // a pull request notice: pushed from the watcher's report
  if (e.decision) return { key: `${e.projectId}\0${e.sessionId}\0d\0${e.decision.at}`, kind: 'decision' }
  if (e.status === 'attention' || e.status === 'done') return { key: `${e.projectId}\0${e.sessionId}\0f\0${e.since}`, kind: 'session-finished' }
  return undefined
}

export class Pusher {
  private readonly deps: PusherDeps
  private attention?: AttentionTopic
  private seen = new Set<string>()
  private readonly lastSent = new Map<string, number>()
  private unsubscribe?: () => void
  private stopped = false
  private readonly inFlight = new Set<Promise<void>>()

  constructor(deps: PusherDeps) {
    this.deps = deps
  }

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }

  /** Follows `attention` from its current state: what is already listed is never pushed. */
  start(): void {
    const subscriber: Subscriber = {
      send: (_topic, _rev, ops: PatchOp[]) => {
        if (!this.attention) return
        this.attention = applyPatch(this.attention, ops)
        this.onAttention()
      },
      ended: () => {
        this.attention = undefined
      }
    }
    const start = this.deps.hub.subscribe('attention', subscriber)
    if (start) {
      this.attention = start.snapshot as AttentionTopic
      this.seen = new Set(this.attention.entries.map((e) => entryKey(e)?.key).filter((k): k is string => k !== undefined))
    }
    this.unsubscribe = () => this.deps.hub.unsubscribe('attention', subscriber)
  }

  private onAttention(): void {
    const keys = new Set<string>()
    for (const e of this.attention?.entries ?? []) {
      const k = entryKey(e)
      if (!k) continue
      keys.add(k.key)
      if (this.seen.has(k.key)) continue
      this.notify({ kind: k.kind, projectId: e.projectId, projectName: e.projectName, worktreeId: e.worktreeId, sessionId: e.sessionId })
    }
    // Forget what left the list: the same decision asked again later is new.
    this.seen = keys
  }

  /** A pull request report (the watcher's): one push of its most pressing event */
  prReport(p: { projectId: string; projectName: string; worktreeId: string; events: readonly PrEvent[] }): void {
    const kind = prPushKind(p.events)
    if (kind) this.notify({ kind, projectId: p.projectId, projectName: p.projectName, worktreeId: p.worktreeId })
  }

  /** Sends `event` to every grant that wants it now. */
  notify(event: PushEvent): void {
    if (this.stopped) return
    const group = pushGroupOf(event.kind)
    const now = this.now()
    for (const [name, grant] of this.deps.grants.active()) {
      if (grant.paused || !grant.kinds[group]) continue
      if (this.deps.isConnected(name)) continue
      const coalesce = `${name}\0${event.projectId}\0${event.kind}`
      const last = this.lastSent.get(coalesce)
      if (last !== undefined && now - last < COALESCE_MS) continue
      this.lastSent.set(coalesce, now)
      const data: PushData = { serverId: this.deps.serverId(), projectId: event.projectId }
      if (event.worktreeId) data.worktreeId = event.worktreeId
      if (event.sessionId) data.sessionId = event.sessionId
      const body: RelayPushBody = { kind: event.kind, project: event.projectName, data }
      const job = this.post(name, grant.relayUrl, grant.grantSecret, body).finally(() => this.inFlight.delete(job))
      this.inFlight.add(job)
    }
    if (this.lastSent.size > 5_000) {
      for (const [k, t] of this.lastSent) if (now - t >= COALESCE_MS) this.lastSent.delete(k)
    }
  }

  private async post(name: string, relayUrl: string, secret: string, body: RelayPushBody): Promise<void> {
    const doFetch = this.deps.fetch ?? fetch
    const sleep = this.deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref?.()))
    const log = this.deps.log ?? ((line: string) => console.warn(line))
    let lastError = ''
    for (let attempt = 0; attempt <= PUSH_RETRIES; attempt += 1) {
      if (this.stopped) return
      if (attempt > 0) await sleep(BACKOFF_MS[Math.min(attempt - 1, BACKOFF_MS.length - 1)])
      let status = 0
      try {
        const res = await doFetch(`${relayUrl}/v1/push`, {
          method: 'POST',
          headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(POST_TIMEOUT_MS)
        })
        status = res.status
        await res.body?.cancel().catch(() => {})
      } catch (err) {
        lastError = `the relay could not be reached: ${(err as Error).message}`
        continue
      }
      if (status >= 200 && status < 300) {
        this.deps.grants.pushed(name, this.now())
        return
      }
      if (status === 401 || status === 404 || status === 410) {
        const why = status === 410 ? 'the relay says this phone is gone (grant again)' : 'the relay no longer knows this grant (grant again)'
        log(`[push] dropping token "${name}"'s grant: the relay answered ${status}`)
        this.deps.grants.refused(name, why)
        return
      }
      if (status === 429) {
        this.deps.grants.pushed(name, this.now(), 'the relay is limiting pushes (429)')
        return
      }
      lastError = `the relay answered ${status}`
      if (status < 500) break
    }
    log(`[push] a ${body.kind} push for token "${name}" failed: ${lastError}`)
    this.deps.grants.pushed(name, this.now(), lastError)
  }

  /** Waits for the pushes on their way (tests and shutdown) */
  async idle(): Promise<void> {
    while (this.inFlight.size) await Promise.allSettled([...this.inFlight])
  }

  stop(): void {
    this.stopped = true
    this.unsubscribe?.()
  }
}
