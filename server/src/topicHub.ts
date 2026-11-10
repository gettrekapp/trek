// Server side of protocol v2 subscriptions. Each topic has a current snapshot
// and a rev; publishing a new snapshot bumps the rev by one and sends every
// subscriber the diff as a single patch. Snapshots are treated as immutable:
// callers build a fresh object for each publish.
import type { Topic } from '../../src/shared/model/topics'
import type { EventFrame, TopicEndReason } from '../../src/shared/protocolV2'
import { diffJson } from '../../src/shared/sync/jsonDiff.ts'
import type { PatchOp } from '../../src/shared/sync/jsonPatch'

export interface Subscriber {
  send(topic: Topic, rev: number, ops: PatchOp[]): void
  /** The topic stopped for good (see `drop`); without it the subscriber is just forgotten */
  ended?(topic: Topic, reason: TopicEndReason): void
  /**
   * An event for the topic's subscribers (`voice.summary`); false when it was not sent (a congested
   * connection). `frame()` is the event frame's JSON, built on the first call and shared by every
   * subscriber of one emit (a clip is serialized once, not once per window).
   */
  event?(event: string, payload: unknown, frame: () => string): boolean
}

interface TopicEntry {
  snapshot: unknown
  rev: number
  subscribers: Set<Subscriber>
}

export class TopicHub {
  private topics = new Map<Topic, TopicEntry>()
  private subscribeListeners = new Set<(topic: Topic) => void>()

  /**
   * Called after a subscriber joins a topic it was not on. Runs inside subscribe(),
   * before the response is written, so a listener must not publish synchronously.
   * Returns a function that removes the listener.
   */
  onSubscribe(listener: (topic: Topic) => void): () => void {
    this.subscribeListeners.add(listener)
    return () => this.subscribeListeners.delete(listener)
  }

  /** The topic's current rev; undefined if it was never published or was dropped. */
  rev(topic: Topic): number | undefined {
    return this.topics.get(topic)?.rev
  }

  subscriberCount(topic: Topic): number {
    return this.topics.get(topic)?.subscribers.size ?? 0
  }

  /** The subscribers `emit` could reach: connections, not an MCP tool call's no-op subscriber. */
  eventSubscriberCount(topic: Topic): number {
    let count = 0
    for (const subscriber of this.topics.get(topic)?.subscribers ?? []) if (subscriber.event) count += 1
    return count
  }

  /** Sets the topic's state. The first publish starts at rev 0; an unchanged snapshot sends nothing. */
  publish(topic: Topic, snapshot: unknown): void {
    const entry = this.topics.get(topic)
    if (!entry) {
      this.topics.set(topic, { snapshot, rev: 0, subscribers: new Set() })
      return
    }
    const ops = diffJson(entry.snapshot, snapshot)
    if (ops.length === 0) return
    entry.snapshot = snapshot
    entry.rev += 1
    for (const subscriber of [...entry.subscribers]) {
      try {
        subscriber.send(topic, entry.rev, ops)
      } catch (err) {
        console.warn(`topic ${topic}: dropping subscriber after send failed`, err)
        this.unsubscribeAll(subscriber)
      }
    }
  }

  /**
   * Adds the subscriber and returns the state it starts from; undefined if the topic was never published.
   * The caller must write the subscribe response before yielding to the event loop and must send
   * patches through the same socket, so the response always precedes any patch past its rev
   * (PROTOCOL.md "Subscriptions").
   */
  subscribe(topic: Topic, subscriber: Subscriber): { snapshot: unknown; rev: number } | undefined {
    const entry = this.topics.get(topic)
    if (!entry) return undefined
    const joined = !entry.subscribers.has(subscriber)
    entry.subscribers.add(subscriber)
    if (joined) {
      for (const listener of [...this.subscribeListeners]) {
        try {
          listener(topic)
        } catch (err) {
          console.warn(`topic ${topic}: subscribe listener failed`, err)
        }
      }
    }
    return { snapshot: entry.snapshot, rev: entry.rev }
  }

  /**
   * Forgets the topic (a deleted project) and tells each of its subscribers it
   * ended. A subscriber whose `ended` throws is logged; the others still hear it.
   */
  drop(topic: Topic, reason: TopicEndReason = 'deleted'): void {
    const entry = this.topics.get(topic)
    if (!entry) return
    this.topics.delete(topic)
    for (const subscriber of [...entry.subscribers]) {
      try {
        subscriber.ended?.(topic, reason)
      } catch (err) {
        console.warn(`topic ${topic}: telling a subscriber it ended failed`, err)
      }
    }
  }

  /**
   * Sends an event to each of the topic's subscribers that takes events (a connection: not an MCP
   * tool call's no-op subscriber). Returns how many it went to. One that throws is logged and skipped.
   */
  emit(topic: Topic, event: string, payload: unknown): number {
    const entry = this.topics.get(topic)
    if (!entry) return 0
    let sent = 0
    let json: string | undefined
    const frame = (): string => (json ??= JSON.stringify({ type: 'event', event, payload } satisfies EventFrame))
    for (const subscriber of [...entry.subscribers]) {
      if (!subscriber.event) continue
      try {
        if (subscriber.event(event, payload, frame)) sent += 1
      } catch (err) {
        console.warn(`topic ${topic}: sending ${event} to a subscriber failed`, err)
      }
    }
    return sent
  }

  unsubscribe(topic: Topic, subscriber: Subscriber): void {
    this.topics.get(topic)?.subscribers.delete(subscriber)
  }

  unsubscribeAll(subscriber: Subscriber): void {
    for (const entry of this.topics.values()) entry.subscribers.delete(subscriber)
  }
}
