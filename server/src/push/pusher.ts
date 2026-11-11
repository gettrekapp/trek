// Background push (6b): what the server sends to a phone's relay, and when. It follows the
// `attention` topic (a decision asked, a session waiting for the user) and hears session exits and
// pull request reports directly. For each phone grant that wants that kind, isn't paused, and whose
// token has no live connection (the app shows it already), it posts the kind, the project's name
// and the ids to the relay. One push per (token, project, kind) in 30 seconds, the two session
// kinds counting as one (an exit right after "waiting" sends "stopped" only); a 503 or a network
// error is retried (3 times, backing off, honouring Retry-After); a 422 is not; a 401/404/410 means
// the grant is gone, so it is dropped. An attention entry that arrived while the token was
// connected is pushed when its last connection closes, if it is still open and arrived after the
// last frame the server heard from that token (iOS suspends the app long before the server sees its
// socket drop; a pong or a request after the entry means the phone was awake to show it).
import type { AttentionEntry } from '../../../src/shared/model/types.ts'
import type { AttentionTopic } from '../../../src/shared/model/topics.ts'
import type { PrEvent } from '../../../src/shared/prWatch.ts'
import { pushGroupOf, type PushData, type PushKind, type RelayPushBody } from '../../../src/shared/push.ts'
import { applyPatch, type PatchOp } from '../../../src/shared/sync/jsonPatch.ts'
import type { Subscriber, TopicHub } from '../topicHub.ts'
import type { PushGrants } from './grants.ts'

export const COALESCE_MS = 30_000
/** A session push waits this long, so an exit that follows "waiting" sends "stopped" instead */
export const SESSION_HOLD_MS = 2_000
export const PUSH_RETRIES = 3
const BACKOFF_MS = [1_000, 3_000, 10_000]
/** The longest Retry-After a 503 is honoured for */
export const MAX_RETRY_AFTER_MS = 30_000
/** Attention entries remembered per connected token, to push when it disconnects */
export const MAX_HELD_WHILE_CONNECTED = 50
const POST_TIMEOUT_MS = 10_000
/** push.status's lastError for a push the relay accepted and dropped (202 `{paused: true}`) */
export const RELAY_PAUSED_NOTE = 'the relay dropped it: the phone paused every push there'
const RESUBSCRIBE_MS = 1_000

export interface PushEvent {
  kind: PushKind
  projectId: string
  projectName: string
  worktreeId?: string | null
  sessionId?: string
  /** The attention entry it came from (pushed again on a disconnect only while still listed) */
  entryKey?: string
}

export interface PusherDeps {
  hub: TopicHub
  grants: PushGrants
  /** Whether any phone connection (hello `client: 'trek-mobile'`) signed in with this token is open now */
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

/** A Retry-After header in ms (seconds or an HTTP date), or undefined */
function retryAfterMs(value: string | null, now: number): number | undefined {
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000
  const at = Date.parse(value)
  return Number.isNaN(at) ? undefined : Math.max(0, at - now)
}

export class Pusher {
  private readonly deps: PusherDeps
  private attention?: AttentionTopic
  private seen = new Set<string>()
  private readonly lastSent = new Map<string, number>()
  /** A session push waiting out SESSION_HOLD_MS, per (token, project) */
  private readonly heldSession = new Map<string, { event: PushEvent }>()
  /** Per connected token: the attention entries it would have been pushed, each with when it arrived */
  private readonly whileConnected = new Map<string, Map<string, { event: PushEvent; at: number }>>()
  /** Per connected token: when the server last heard a frame (a pong or a message) from it */
  private readonly heardAt = new Map<string, number>()
  /** The pusher's own clock for heardAt and remembered entries: strictly increasing, so ties can't happen */
  private tick = 0
  private unsubscribe?: () => void
  private resubscribeTimer?: NodeJS.Timeout
  private stopped = false
  private readonly abort = new AbortController()
  private readonly inFlight = new Set<Promise<void>>()

  constructor(deps: PusherDeps) {
    this.deps = deps
  }

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }

  private sleep(ms: number): Promise<void> {
    if (this.deps.sleep) return this.deps.sleep(ms)
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms)
      timer.unref?.()
      this.abort.signal.addEventListener('abort', () => (clearTimeout(timer), resolve()), { once: true })
    })
  }

  private track(job: Promise<void>): void {
    const tracked = job.catch(() => {}).finally(() => this.inFlight.delete(tracked))
    this.inFlight.add(tracked)
  }

  /** Follows `attention` from its current state: what is already listed is never pushed. */
  start(): void {
    if (this.stopped) return
    const subscriber: Subscriber = {
      send: (_topic, _rev, ops: PatchOp[]) => {
        if (!this.attention) return
        this.attention = applyPatch(this.attention, ops)
        this.onAttention()
      },
      // The topic ended: follow it again from its next state (unless stopping).
      ended: () => {
        this.attention = undefined
        this.unsubscribe = undefined
        this.resubscribeLater()
      }
    }
    const start = this.deps.hub.subscribe('attention', subscriber)
    if (!start) {
      this.resubscribeLater()
      return
    }
    this.attention = start.snapshot as AttentionTopic
    this.seen = new Set(this.attention.entries.map((e) => entryKey(e)?.key).filter((k): k is string => k !== undefined))
    this.unsubscribe = () => this.deps.hub.unsubscribe('attention', subscriber)
  }

  private resubscribeLater(): void {
    if (this.stopped || this.resubscribeTimer) return
    this.resubscribeTimer = setTimeout(() => {
      this.resubscribeTimer = undefined
      this.start()
    }, RESUBSCRIBE_MS)
    this.resubscribeTimer.unref?.()
  }

  private onAttention(): void {
    const keys = new Set<string>()
    for (const e of this.attention?.entries ?? []) {
      const k = entryKey(e)
      if (!k) continue
      keys.add(k.key)
      if (this.seen.has(k.key)) continue
      this.notify({ kind: k.kind, projectId: e.projectId, projectName: e.projectName, worktreeId: e.worktreeId, sessionId: e.sessionId, entryKey: k.key })
    }
    // Forget what left the list: the same decision asked again later is new.
    this.seen = keys
  }

  /** A pull request report (the watcher's): one push of its most pressing event */
  prReport(p: { projectId: string; projectName: string; worktreeId: string; events: readonly PrEvent[] }): void {
    const kind = prPushKind(p.events)
    if (kind) this.notify({ kind, projectId: p.projectId, projectName: p.projectName, worktreeId: p.worktreeId })
  }

  /**
   * The token's last connection closed: the attention entries that arrived while it was connected
   * and are still listed are pushed now (through the usual switches and coalescing).
   */
  tokenDisconnected(name: string): void {
    if (this.deps.isConnected(name)) return
    const held = this.whileConnected.get(name)
    const heard = this.heardAt.get(name) ?? -Infinity
    this.whileConnected.delete(name)
    this.heardAt.delete(name)
    if (!held || this.stopped) return
    // An entry the phone was heard from after had reached an awake app: it was shown, not pushed.
    for (const [key, { event, at }] of held) if (at > heard && this.seen.has(key)) this.notify(event, name)
  }

  /**
   * The server heard a frame (a pong or any message) from one of the token's phone connections:
   * what it remembered for that token until now reached an awake app.
   */
  heardFrom(name: string): void {
    this.heardAt.set(name, ++this.tick)
  }

  /** Sends `event` to every grant that wants it now (or only `onlyToken`'s). */
  notify(event: PushEvent, onlyToken?: string): void {
    if (this.stopped) return
    const group = pushGroupOf(event.kind)
    const now = this.now()
    for (const [name, grant] of this.deps.grants.active()) {
      if (onlyToken !== undefined && name !== onlyToken) continue
      if (grant.paused || !grant.kinds[group]) continue
      if (this.deps.isConnected(name)) {
        if (event.entryKey) this.remember(name, event)
        continue
      }
      if (group === 'sessions') {
        this.holdSession(name, event, now)
        continue
      }
      const coalesce = `${name}\0${event.projectId}\0${event.kind}`
      if (this.coalesced(coalesce, now)) continue
      this.track(this.post(name, grant.relayUrl, grant.grantSecret, this.bodyOf(event)))
    }
    if (this.lastSent.size > 5_000) {
      for (const [k, t] of this.lastSent) if (now - t >= COALESCE_MS) this.lastSent.delete(k)
    }
  }

  /** Whether `key` was sent in the last COALESCE_MS; if not, it is now */
  private coalesced(key: string, now: number): boolean {
    const last = this.lastSent.get(key)
    if (last !== undefined && now - last < COALESCE_MS) return true
    this.lastSent.set(key, now)
    return false
  }

  private remember(name: string, event: PushEvent): void {
    let held = this.whileConnected.get(name)
    if (!held) this.whileConnected.set(name, (held = new Map()))
    held.delete(event.entryKey!)
    held.set(event.entryKey!, { event, at: ++this.tick })
    while (held.size > MAX_HELD_WHILE_CONNECTED) held.delete(held.keys().next().value!)
  }

  /** The session kinds are one group per (token, project): held briefly, "stopped" wins over "waiting". */
  private holdSession(name: string, event: PushEvent, now: number): void {
    const key = `${name}\0${event.projectId}\0sessions`
    const held = this.heldSession.get(key)
    if (held) {
      if (event.kind === 'session-stopped' && held.event.kind !== 'session-stopped') held.event = event
      return
    }
    if (this.coalesced(key, now)) return
    const slot = { event }
    this.heldSession.set(key, slot)
    this.track(
      (async () => {
        await this.sleep(SESSION_HOLD_MS)
        this.heldSession.delete(key)
        if (this.stopped) return
        // The grant as it is now: the phone may have changed it (or connected) while this waited.
        const grant = this.deps.grants.get(name)
        const connected = this.deps.isConnected(name)
        if (connected || !grant || !grant.grantSecret || grant.paused || !grant.kinds.sessions) {
          if (this.lastSent.get(key) === now) this.lastSent.delete(key)
          if (connected && slot.event.entryKey) this.remember(name, slot.event)
          return
        }
        await this.post(name, grant.relayUrl, grant.grantSecret, this.bodyOf(slot.event))
      })()
    )
  }

  private bodyOf(event: PushEvent): RelayPushBody {
    const data: PushData = { serverId: this.deps.serverId(), projectId: event.projectId }
    if (event.worktreeId) data.worktreeId = event.worktreeId
    if (event.sessionId) data.sessionId = event.sessionId
    return { kind: event.kind, project: event.projectName, data }
  }

  private async post(name: string, relayUrl: string, secret: string, body: RelayPushBody): Promise<void> {
    const doFetch = this.deps.fetch ?? fetch
    const log = this.deps.log ?? ((line: string) => console.warn(line))
    let lastError = ''
    let wait = 0
    for (let attempt = 0; attempt <= PUSH_RETRIES; attempt += 1) {
      if (this.stopped) return
      if (attempt > 0) {
        await this.sleep(wait)
        if (this.stopped) return
      }
      wait = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]
      let status = 0
      let retryAfter: string | null = null
      let droppedPaused = false
      try {
        const res = await doFetch(`${relayUrl}/v1/push`, {
          method: 'POST',
          headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
          body: JSON.stringify(body),
          // A relay never redirects: following one would hand the grant secret to another host.
          redirect: 'error',
          signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(POST_TIMEOUT_MS)])
        })
        status = res.status
        retryAfter = res.headers.get('retry-after')
        if (status >= 200 && status < 300) {
          // `{accepted: true, paused: true}`: the relay dropped it (the phone paused every push there).
          const text = await res.text().catch(() => '')
          try {
            droppedPaused = text.length <= 4096 && (JSON.parse(text) as { paused?: unknown })?.paused === true
          } catch {
            droppedPaused = false
          }
        } else await res.body?.cancel().catch(() => {})
      } catch (err) {
        if (this.stopped) return
        lastError = `the relay could not be reached: ${(err as Error).message}`
        continue
      }
      if (status >= 200 && status < 300) {
        // Dropped by the relay is not delivered: no lastPushAt, a note instead.
        if (droppedPaused) this.deps.grants.pushed(name, this.now(), secret, RELAY_PAUSED_NOTE)
        else this.deps.grants.pushed(name, this.now(), secret)
        return
      }
      if (status === 401 || status === 404 || status === 410) {
        const why = status === 410 ? 'the relay says this phone is gone (grant again)' : 'the relay no longer knows this grant (grant again)'
        log(`[push] dropping token "${name}"'s grant: the relay answered ${status}`)
        this.deps.grants.refused(name, why, secret)
        return
      }
      if (status === 429) {
        this.deps.grants.pushed(name, this.now(), secret, 'the relay is limiting pushes (429)')
        return
      }
      if (status === 503) {
        lastError = 'the push service is unavailable (503)'
        const after = retryAfterMs(retryAfter, this.now())
        if (after !== undefined) wait = Math.min(MAX_RETRY_AFTER_MS, after)
        continue
      }
      lastError = status === 422 ? 'the push service refused this push (422)' : `the relay answered ${status}`
      break
    }
    log(`[push] a ${body.kind} push for token "${name}" failed: ${lastError}`)
    this.deps.grants.pushed(name, this.now(), secret, lastError)
  }

  /** Waits for the pushes on their way (tests and shutdown) */
  async idle(): Promise<void> {
    while (this.inFlight.size) await Promise.allSettled([...this.inFlight])
  }

  /** Stops following attention and aborts the pushes on their way. */
  stop(): void {
    this.stopped = true
    clearTimeout(this.resubscribeTimer)
    this.resubscribeTimer = undefined
    this.unsubscribe?.()
    this.unsubscribe = undefined
    this.abort.abort()
  }
}
