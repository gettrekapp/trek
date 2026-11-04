// Client side of protocol v2 subscriptions: a topic's snapshot plus the rev it
// is at. A client keeps one TopicState per (server, topic) and feeds every
// `state.patch` event through applyStatePatch. On 'resync' it re-sends
// `sub.subscribe` and replaces the state with the fresh snapshot.
import { applyPatch, PatchError, type PatchOp } from './jsonPatch.ts'

export interface TopicState<T> {
  snapshot: T
  rev: number
}

/** Payload of a `state.patch` event. `rev` goes up by exactly 1 per patch. */
export interface StatePatch {
  topic: string
  rev: number
  ops: PatchOp[]
}

export type PatchOutcome<T> =
  | { kind: 'applied'; state: TopicState<T> }
  /** Already reflected in the state (a duplicate, or sent before the snapshot was taken). */
  | { kind: 'stale' }
  /** The client missed a patch, or the patch does not fit its snapshot. */
  | { kind: 'resync'; reason: 'gap' | 'invalid' }

export function applyStatePatch<T>(state: TopicState<T>, patch: StatePatch): PatchOutcome<T> {
  if (patch.rev <= state.rev) return { kind: 'stale' }
  if (patch.rev !== state.rev + 1) return { kind: 'resync', reason: 'gap' }
  try {
    return {
      kind: 'applied',
      state: { snapshot: applyPatch(state.snapshot, patch.ops), rev: patch.rev }
    }
  } catch (err) {
    if (err instanceof PatchError) return { kind: 'resync', reason: 'invalid' }
    throw err
  }
}
