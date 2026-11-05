// Server side of protocol v2 subscriptions. Each topic has a current snapshot
// and a rev; publishing a new snapshot bumps the rev by one and sends every
// subscriber the diff as a single patch. Snapshots are treated as immutable:
// callers build a fresh object for each publish.
import type { Topic } from '../../src/shared/model/topics'
import { diffJson } from '../../src/shared/sync/jsonDiff.ts'
import type { PatchOp } from '../../src/shared/sync/jsonPatch'

export interface Subscriber {
  send(topic: Topic, rev: number, ops: PatchOp[]): void
}

interface TopicEntry {
  snapshot: unknown
  rev: number
  subscribers: Set<Subscriber>
}

export class TopicHub {
  private topics = new Map<Topic, TopicEntry>()

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
    for (const subscriber of entry.subscribers) subscriber.send(topic, entry.rev, ops)
  }

  /** Adds the subscriber and returns the state it starts from; undefined if the topic was never published. */
  subscribe(topic: Topic, subscriber: Subscriber): { snapshot: unknown; rev: number } | undefined {
    const entry = this.topics.get(topic)
    if (!entry) return undefined
    entry.subscribers.add(subscriber)
    return { snapshot: entry.snapshot, rev: entry.rev }
  }

  unsubscribe(topic: Topic, subscriber: Subscriber): void {
    this.topics.get(topic)?.subscribers.delete(subscriber)
  }

  unsubscribeAll(subscriber: Subscriber): void {
    for (const entry of this.topics.values()) entry.subscribers.delete(subscriber)
  }
}
