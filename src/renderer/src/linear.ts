import { useEffect } from 'react'
import { allBranchTickets, isLinearTicket, useAppStore } from './store'
import { useFeatures } from './useFeatures'

const REFRESH_MS = 5 * 60_000
/** Window focus refreshes, but not more often than this. */
const FOCUS_THROTTLE_MS = 60_000

let lastRefresh = 0

function linkedLinearIds(): string[] {
  const tickets = allBranchTickets(useAppStore.getState().project)
  return [...new Set(tickets.filter(isLinearTicket))].sort()
}

export async function refreshLinearIssues(ids = linkedLinearIds()): Promise<void> {
  if (!useAppStore.getState().linearConnected || ids.length === 0) return
  lastRefresh = Date.now()
  try {
    useAppStore.getState().setLinearIssues(await window.api.linearFetchIssues(ids))
  } catch (err) {
    // Chips fall back to the bare id; the next refresh retries.
    console.warn('Linear issue refresh failed', err)
  }
}

/** Keeps the store's Linear issue cache fresh for the open project's tickets. */
export function useLinearSync(): void {
  const connected = useAppStore((s) => s.linearConnected)
  // A server window hides Linear (phase 5); the effect re-runs when the window's kind changes.
  const linear = useFeatures().linear
  // Joined so the effect only re-runs when the set of linked ids changes.
  const idsKey = useAppStore((s) =>
    [...new Set(allBranchTickets(s.project).filter(isLinearTicket))]
      .sort()
      .join(',')
  )

  useEffect(() => {
    void window.api.linearHasApiKey().then((has) => {
      useAppStore.getState().setLinearConnected(has)
    })
  }, [])

  useEffect(() => {
    if (!connected || !idsKey || !linear) return
    void refreshLinearIssues(idsKey.split(','))
    const timer = setInterval(() => {
      if (document.hasFocus()) void refreshLinearIssues()
    }, REFRESH_MS)
    const onFocus = (): void => {
      if (Date.now() - lastRefresh > FOCUS_THROTTLE_MS) void refreshLinearIssues()
    }
    window.addEventListener('focus', onFocus)
    return () => {
      clearInterval(timer)
      window.removeEventListener('focus', onFocus)
    }
  }, [connected, idsKey, linear])
}
