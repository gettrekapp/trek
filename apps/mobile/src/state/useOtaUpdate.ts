// Over-the-air updates: checks on launch and when the app returns to the foreground (the rules
// in logic/updates.ts), downloads a new bundle, and says when the "Update ready" banner shows.
// A failed check or download is logged and otherwise ignored: the phone keeps running what it has,
// and (as a check counts from when it starts) tries again on a launch or after the interval.
import { useCallback, useEffect, useRef, useState } from 'react'
import { AppState } from 'react-native'
import * as Updates from 'expo-updates'
import { bannerVisible, pendingKey, shouldCheck, shouldFetch, type CheckReason } from '../logic/updates.ts'

export function useOtaUpdate(): { visible: boolean; restart: () => void; dismiss: () => void } {
  const { isUpdatePending, downloadedUpdate } = Updates.useUpdates()
  const lastCheckAt = useRef<number | null>(null)
  const inFlight = useRef(false)
  const [dismissedUpdateId, setDismissedUpdateId] = useState<string | null>(null)

  const check = useCallback(async (reason: CheckReason): Promise<void> => {
    const now = Date.now()
    if (!shouldCheck({ enabled: Updates.isEnabled, isDev: __DEV__, inFlight: inFlight.current, reason, lastCheckAt: lastCheckAt.current, now })) return
    lastCheckAt.current = now
    inFlight.current = true
    try {
      const result = await Updates.checkForUpdateAsync()
      if (shouldFetch(result)) await Updates.fetchUpdateAsync()
    } catch (err) {
      console.warn('[updates] check or download failed', err)
    } finally {
      inFlight.current = false
    }
  }, [])

  useEffect(() => {
    void check('launch')
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') void check('foreground')
    })
    return () => sub.remove()
  }, [check])

  const pendingUpdateId = pendingKey({ isUpdatePending, updateId: downloadedUpdate?.updateId, createdAt: downloadedUpdate?.createdAt })
  const restart = useCallback(() => {
    Updates.reloadAsync().catch((err: unknown) => console.warn('[updates] restart failed', err))
  }, [])
  const dismiss = useCallback(() => setDismissedUpdateId(pendingUpdateId), [pendingUpdateId])
  return { visible: bannerVisible({ pendingUpdateId, dismissedUpdateId }), restart, dismiss }
}
