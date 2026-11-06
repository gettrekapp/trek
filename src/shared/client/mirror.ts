// Keeps one snapshot+rev per subscribed topic in step with the server through
// state.patch events; resubscribes on a gap or after a reconnect.
import type { Topic } from '../model/topics.ts'
import { applyStatePatch, type TopicState } from '../sync/topicState.ts'
import type { ClientError, ServerConnection } from './connection.ts'

export type MirrorUpdate = TopicState<unknown> | { error: ClientError }
type Listener = (update: MirrorUpdate) => void

interface Entry {
  listeners: Set<Listener>
  state?: TopicState<unknown>
  error?: ClientError
  /** Bumped per subscribe attempt, so a late reply from an older attempt is ignored */
  attempt: number
  /** A sub.subscribe is in flight: patches meanwhile are older than its snapshot, so they are ignored */
  loading: boolean
  /** Pending retry after a transient subscribe failure */
  retryTimer: unknown
  /** The next retry's delay */
  retryDelay: number
}

/** A subscribe that fails transiently (not NOT_FOUND or NOT_CONNECTED) is retried after 1 s, doubling to 30 s. */
const RETRY_MIN_MS = 1000
const RETRY_MAX_MS = 30_000

export class TopicMirror {
  private readonly conn: ServerConnection
  private readonly topics = new Map<Topic, Entry>()

  constructor(conn: ServerConnection) {
    this.conn = conn
    conn.on('welcome', () => {
      for (const [topic, entry] of this.topics) {
        this.cancelRetry(entry)
        entry.retryDelay = RETRY_MIN_MS
        this.resubscribe(topic)
      }
    })
    conn.on('event', ({ event, payload }) => {
      if (event === 'state.patch') this.onPatch(payload as { topic: Topic; rev: number; ops: [] })
    })
  }

  subscribe(topic: Topic, listener: Listener): () => void {
    let entry = this.topics.get(topic)
    if (!entry) {
      entry = { listeners: new Set(), attempt: 0, loading: false, retryTimer: null, retryDelay: RETRY_MIN_MS }
      this.topics.set(topic, entry)
      entry.listeners.add(listener)
      if (this.conn.status === 'connected') this.resubscribe(topic)
    } else {
      entry.listeners.add(listener)
      if (entry.state) this.call(listener, entry.state)
      else if (entry.error) this.call(listener, { error: entry.error })
    }
    let active = true
    return () => {
      if (!active) return
      active = false
      const current = this.topics.get(topic)
      if (!current) return
      current.listeners.delete(listener)
      if (current.listeners.size > 0) return
      this.topics.delete(topic)
      this.cancelRetry(current)
      this.conn.request('sub.unsubscribe', { topic }).catch(() => {})
    }
  }

  get(topic: Topic): TopicState<unknown> | undefined {
    return this.topics.get(topic)?.state
  }

  private resubscribe(topic: Topic): void {
    const entry = this.topics.get(topic)
    if (!entry) return
    this.cancelRetry(entry)
    const attempt = ++entry.attempt
    entry.loading = true
    this.conn.request('sub.subscribe', { topic }).then(
      (result) => {
        if (this.topics.get(topic) !== entry || entry.attempt !== attempt) return
        entry.loading = false
        entry.state = { snapshot: result.snapshot, rev: result.rev }
        entry.error = undefined
        entry.retryDelay = RETRY_MIN_MS
        this.notify(entry, entry.state)
      },
      (err: ClientError) => {
        if (this.topics.get(topic) !== entry || entry.attempt !== attempt) return
        entry.loading = false
        if (err.code === 'NOT_CONNECTED') return // the next welcome resubscribes
        // The topic is gone: drop the state so stale data is not shown or patched.
        if (err.code === 'NOT_FOUND') entry.state = undefined
        entry.error = err
        this.notify(entry, { error: err })
        // Anything else (TIMEOUT, INTERNAL, ...) may pass: try again with back-off.
        if (err.code !== 'NOT_FOUND' && this.topics.get(topic) === entry) this.scheduleRetry(topic, entry)
      }
    )
  }

  private scheduleRetry(topic: Topic, entry: Entry): void {
    this.cancelRetry(entry)
    const delay = entry.retryDelay
    entry.retryDelay = Math.min(delay * 2, RETRY_MAX_MS)
    entry.retryTimer = this.conn.timers.setTimeout(() => {
      entry.retryTimer = null
      if (this.topics.get(topic) === entry) this.resubscribe(topic)
    }, delay)
  }

  private cancelRetry(entry: Entry): void {
    if (entry.retryTimer === null) return
    this.conn.timers.clearTimeout(entry.retryTimer)
    entry.retryTimer = null
  }

  private onPatch(patch: { topic: Topic; rev: number; ops: [] }): void {
    const entry = this.topics.get(patch.topic)
    if (!entry?.state || entry.loading) return
    const outcome = applyStatePatch(entry.state, patch)
    if (outcome.kind === 'applied') {
      entry.state = outcome.state
      this.notify(entry, entry.state)
    } else if (outcome.kind === 'resync') {
      this.resubscribe(patch.topic)
    }
  }

  private notify(entry: Entry, update: MirrorUpdate): void {
    for (const l of [...entry.listeners]) this.call(l, update)
  }

  /** A throwing listener must not stop the others or break the mirror. */
  private call(listener: Listener, update: MirrorUpdate): void {
    try {
      listener(update)
    } catch (err) {
      console.error('mirror listener failed', err)
    }
  }
}
