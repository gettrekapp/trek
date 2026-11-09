import { useEffect } from 'react'
import { allBranchTickets, isLinearTicket, useAppStore } from './store'
import { getBackend } from './backend'
import { useFeatures } from './useFeatures'

// The ticket chips' Linear issues, looked up by the window's server with its own key (5b).

const REFRESH_MS = 5 * 60_000
/** Window focus refreshes, but not more often than this. */
const FOCUS_THROTTLE_MS = 60_000

let lastRefresh = 0

function linkedLinearIds(): string[] {
  const tickets = allBranchTickets(useAppStore.getState().project)
  return [...new Set(tickets.filter(isLinearTicket))].sort()
}

export async function refreshLinearIssues(ids = linkedLinearIds()): Promise<void> {
  const backend = getBackend()
  if (!backend.features.linear || !useAppStore.getState().linearConnected || ids.length === 0) return
  lastRefresh = Date.now()
  try {
    const issues = await backend.linear.issues(ids)
    // The window moved to another server meanwhile: not its issues.
    if (getBackend() === backend) useAppStore.getState().setLinearIssues(issues)
  } catch (err) {
    // Chips fall back to the bare id; the next refresh retries.
    console.warn('Linear issue refresh failed', err)
  }
}

/** Keeps the store's Linear issue cache fresh for the open project's tickets. */
export function useLinearSync(): void {
  const connected = useAppStore((s) => s.linearConnected)
  // A new object for each backend and each welcome: the key is asked again for the window's server.
  const features = useFeatures()
  const linear = features.linear
  // Joined so the effect only re-runs when the set of linked ids changes.
  const idsKey = useAppStore((s) =>
    [...new Set(allBranchTickets(s.project).filter(isLinearTicket))]
      .sort()
      .join(',')
  )

  useEffect(() => {
    const backend = getBackend()
    if (!backend.features.linear) {
      useAppStore.getState().setLinearConnected(false)
      return
    }
    backend.linear.hasKey().then(
      (has) => {
        if (getBackend() === backend) useAppStore.getState().setLinearConnected(has)
      },
      (err) => console.warn('Linear key check failed', err)
    )
  }, [features])

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
