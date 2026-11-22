// Core's activity feed (campsite part 2): a live fan-out of what happened (activity.ts in the
// plugin contract), fired beside each change. No history or replay. A listener that throws is
// logged (once a minute per listener) and skipped: it never reaches the code that emitted.
import type { SessionStatus } from '../../src/shared/model/types.ts'
import type { ActivityEvent, ActivityStatus } from '../../src/shared/plugins/activity.ts'

// The contract's status list is core's: this fails to compile if either gains a value the other lacks
const sameStatuses: [SessionStatus, ActivityStatus] extends [ActivityStatus, SessionStatus] ? true : never = true
void sameStatuses

export type ActivityListener = (event: ActivityEvent) => void
export interface ActivityFeed {
  emit(event: ActivityEvent): void
  subscribe(listener: ActivityListener): () => void
}

const WARN_EVERY_MS = 60_000

export function createActivityFeed(options: { warn?: (message: string) => void; now?: () => number } = {}): ActivityFeed {
  const warn = options.warn ?? ((m: string) => console.warn(m))
  const now = options.now ?? Date.now
  const listeners = new Set<ActivityListener>()
  const warnedAt = new Map<ActivityListener, number>()
  return {
    emit(event) {
      for (const listener of [...listeners]) {
        try {
          listener(event)
        } catch (err) {
          const last = warnedAt.get(listener)
          if (last === undefined || now() - last >= WARN_EVERY_MS) {
            warnedAt.set(listener, now())
            warn(`[activity] a listener failed on ${event.kind}: ${err instanceof Error ? err.message : String(err)}`)
          }
        }
      }
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
        warnedAt.delete(listener)
      }
    }
  }
}
