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
 * running. An exited tab never writes a rollout, so it must not take the next tab's.
 */
export function pickClaimant<T extends DiscoveryTab>(tabs: T[]): T | undefined {
  let best: T | undefined
  for (const tab of tabs) {
    if (!tab.sessionPending || tab.status === 'exited') continue
    if (!best || tab.startedAt < best.startedAt) best = tab
  }
  return best
}

/** The live tab that would claim next if `exited` were out of the way: launched after it. */
export function nextClaimantAfter<T extends DiscoveryTab>(tabs: T[], exited: DiscoveryTab): T | undefined {
  return pickClaimant(tabs.filter((tab) => tab.id !== exited.id && tab.startedAt > exited.startedAt))
}
