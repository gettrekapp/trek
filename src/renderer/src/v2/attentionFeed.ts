// The sessions that need the user on every app-wide server, as main's
// aggregator broadcasts them (`attention:changed`): a window reads the list
// once (`attention:list`) and follows the broadcast, keeping the snapshot with
// the highest `seq`, so a broadcast that crosses the first read is never
// undone by it. The same shape as appServerLinks.ts's feed. Pure: the api is
// injected (useAttention.ts passes window.api.attention).
import type { AttentionChanged, AttentionItem } from '../../../shared/types'

export interface AttentionApi {
  list(): Promise<AttentionChanged>
  onChanged(callback: (snapshot: AttentionChanged) => void): () => void
}

export interface AttentionFeed {
  /** The same array until something changes (a React snapshot); empty until the first one */
  get(): AttentionItem[]
  /** Starts following on the first subscriber; returns the unsubscribe */
  subscribe(listener: () => void): () => void
}

const NONE: AttentionItem[] = []

export function createAttentionFeed(api: AttentionApi): AttentionFeed {
  let seq = -1
  let items = NONE
  let started = false
  const listeners = new Set<() => void>()
  const take = (snapshot: AttentionChanged): void => {
    if (snapshot.seq <= seq) return
    seq = snapshot.seq
    items = snapshot.items
    for (const l of [...listeners]) l()
  }
  const start = (): void => {
    if (started) return
    started = true
    api.onChanged(take)
    // A failed first read shows nothing until a broadcast comes: the menu has its local entries.
    api.list().then(take, (err: unknown) => console.warn('trek: could not read the attention list', err))
  }
  return {
    get: () => items,
    subscribe: (listener) => {
      listeners.add(listener)
      start()
      return () => {
        listeners.delete(listener)
      }
    }
  }
}
