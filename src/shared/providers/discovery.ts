// Pure rules for binding Codex tabs to the session ids Codex picks for itself.
// Type-only imports: safe for `node --test`.

/** A tab waiting for (or done with) discovery, as the poller sees it. */
export interface DiscoveryTab {
  id: string
  status: string
  sessionPending: boolean
  /** When its agent was last launched (ms) */
  startedAt: number
}

/** Fast polling for a launch's first minute, then slowly. */
export const FAST_POLL_MS = 2000
export const SLOW_POLL_MS = 15_000

export function pollDelay(ageMs: number): number {
  return ageMs < 60_000 ? FAST_POLL_MS : SLOW_POLL_MS
}

/**
 * The tab a folder's next scan is for: the oldest-launched one still pending and still
 * running. A tab that exited (or failed to launch) before being bound is never bound, so
 * it can't take the next tab's rollout.
 */
export function pickClaimant<T extends DiscoveryTab>(tabs: T[]): T | undefined {
  let best: T | undefined
  for (const tab of tabs) {
    if (!tab.sessionPending || tab.status === 'exited') continue
    if (!best || tab.startedAt < best.startedAt) best = tab
  }
  return best
}

/**
 * Whether a host call failed because the host doesn't know the method: a remote daemon
 * older than this app. The daemon answers NOT_FOUND "Unknown method: …"; across IPC only
 * the message survives.
 */
export function isUnknownMethodError(err: unknown): boolean {
  if ((err as { code?: unknown } | null)?.code === 'NOT_FOUND') return true
  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : ''
  return message.includes('Unknown method:')
}
