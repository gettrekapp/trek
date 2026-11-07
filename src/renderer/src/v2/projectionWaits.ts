// The waits a server window's actions make for their result to show up in the
// store: on the response's rev through the mirror, or (from a server that sends
// no rev) on the store itself with a time limit. Pure: installV2.ts supplies the
// mirror, the store's subscribe and the timers.
import type { TopicRev } from '../../../shared/protocolV2'

/** How long an action waits for its result to show up in the store, when the response carries no rev. */
export const PROJECTION_WAIT_MS = 10_000
/**
 * How long it waits for the response's rev. The patch is normally applied
 * before the response arrives; the bound covers a reconnect, whose
 * resubscribe brings it (or the newest state, after a server restart).
 */
export const REV_WAIT_MS = 30_000

/** The part of `TopicMirror` the waits use. */
export interface RevMirror {
  whenRev(topic: TopicRev['topic'], rev: number, opts: { timeoutMs: number }): Promise<unknown>
}

export interface ProjectionWaitDeps {
  /** The window's mirror, or undefined while it has none */
  mirror(): RevMirror | undefined
  /** Whether the window has left its project: nothing starts, and every open wait ends */
  left(): boolean
  /** The store's subscribe: the listener runs after each change; returns the unsubscribe */
  subscribe(listener: () => void): () => void
  setTimeout(run: () => void, ms: number): unknown
  clearTimeout(timer: unknown): void
}

export interface ProjectionWaits {
  /**
   * Resolves with `check()` once the store holds the action's result. With a
   * rev and a mirror it waits for the mirror to hold that rev first, even when
   * `check()` is already true (a note's save compares against exactly the
   * state after it); `whenRev` resolves at once for a rev already held.
   * Without one, `check()` now or on a store change, for up to 10 s.
   * Resolves undefined after `leave`.
   */
  whenProjected<T>(check: () => T | undefined, rev?: TopicRev): Promise<T | undefined>
  /** The waits still open (installV2's repo-path wait adds its own); `cancelAll` ends them. */
  readonly waits: Set<() => void>
  /** Ends every open wait (on leave). */
  cancelAll(): void
}

export function createProjectionWaits(deps: ProjectionWaitDeps): ProjectionWaits {
  const waits = new Set<() => void>()

  /**
   * The mirror holds `rev` (its listener has applied it to the store by the
   * time this resolves), or the wait ended: a timeout, the topic gone or
   * unsubscribed, the connection closed, or `cancelAll`. Never rejects.
   */
  function untilRev(mirror: RevMirror, rev: TopicRev): Promise<void> {
    return new Promise((resolve) => {
      const done = (): void => {
        waits.delete(done)
        resolve()
      }
      waits.add(done)
      mirror.whenRev(rev.topic, rev.rev, { timeoutMs: REV_WAIT_MS }).then(done, done)
    })
  }

  function whenProjected<T>(check: () => T | undefined, rev?: TopicRev): Promise<T | undefined> {
    if (deps.left()) return Promise.resolve(undefined)
    const mirror = deps.mirror()
    if (rev && mirror) return untilRev(mirror, rev).then(() => (deps.left() ? undefined : check()))
    const now = check()
    if (now !== undefined) return Promise.resolve(now)
    return new Promise((resolve) => {
      const done = (value: T | undefined): void => {
        deps.clearTimeout(timer)
        unsubscribe()
        waits.delete(cancel)
        resolve(value)
      }
      const cancel = (): void => done(undefined)
      waits.add(cancel)
      const unsubscribe = deps.subscribe(() => {
        const value = check()
        if (value !== undefined) done(value)
      })
      const timer = deps.setTimeout(cancel, PROJECTION_WAIT_MS)
    })
  }

  return {
    whenProjected,
    waits,
    cancelAll: () => {
      for (const cancel of [...waits]) cancel()
    }
  }
}
