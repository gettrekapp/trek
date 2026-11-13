// The Linear plugin's Runtime, once per project window (phase 5b's useLinearSync): checks whether
// the window's server has a key (and again when it changes, from any client), and looks the
// project's Linear tickets up with it every 5 minutes while the window is focused and when it gets
// focus (at most once a minute), publishing them to the window's ticket chips.
import { useEffect } from 'react'
import { usePluginHost } from '../../../src/shared/plugins/client.ts'
import type { LinearIssue } from '../shared/types.ts'
import { FOCUS_THROTTLE_MS, REFRESH_MS, linearIds, ticketInfoOf } from './issues.ts'
import { useLinearStore } from './store.ts'

export function LinearRuntime(): null {
  const host = usePluginHost()
  const connected = useLinearStore((s) => s.connected)

  useEffect(() => {
    let cancelled = false
    const check = (): void => {
      host.request<{ hasKey: boolean }>('status').then(
        ({ hasKey }) => {
          if (!cancelled && host.isCurrent()) useLinearStore.getState().setConnected(hasKey)
        },
        (err) => console.warn('Linear key check failed', err)
      )
    }
    check()
    // A key set or cleared elsewhere (another window, the hand-over to the Local server).
    const off = host.onChanged(check)
    return () => {
      cancelled = true
      off()
      useLinearStore.getState().setConnected(false)
    }
  }, [host])

  useEffect(() => {
    if (!connected) {
      host.setTicketInfo({})
      return
    }
    let cancelled = false
    let lastRefresh = 0
    const refresh = (): void => {
      const ids = linearIds(host)
      if (ids.length === 0) return host.setTicketInfo({})
      lastRefresh = Date.now()
      host.request<LinearIssue[]>('issues', { ids }).then(
        (issues) => {
          // The window moved on, or this Runtime went away: not its issues.
          if (!cancelled && host.isCurrent()) host.setTicketInfo(ticketInfoOf(issues))
        },
        // Chips fall back to the bare id; the next refresh retries.
        (err) => console.warn('Linear issue refresh failed', err)
      )
    }
    refresh()
    const offIds = host.onTicketIdsChanged(refresh)
    const timer = setInterval(() => {
      if (document.hasFocus()) refresh()
    }, REFRESH_MS)
    const onFocus = (): void => {
      if (Date.now() - lastRefresh > FOCUS_THROTTLE_MS) refresh()
    }
    window.addEventListener('focus', onFocus)
    return () => {
      cancelled = true
      offIds()
      clearInterval(timer)
      window.removeEventListener('focus', onFocus)
      host.setTicketInfo({})
    }
  }, [host, connected])

  return null
}
