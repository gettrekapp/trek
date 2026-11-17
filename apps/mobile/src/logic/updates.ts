// Over-the-air updates (EAS Update): when the phone checks for a new JS bundle, and when the
// "Update ready" banner shows. The app checks on launch and when it comes back to the
// foreground, at most once per FOREGROUND_CHECK_INTERVAL_MS; a downloaded update also applies
// on the next cold start, so "Later" never leaves the phone on old code for good. Pure.

/** The least time between two checks started by the app returning to the foreground. */
export const FOREGROUND_CHECK_INTERVAL_MS = 15 * 60 * 1000

export type CheckReason = 'launch' | 'foreground'

/**
 * Whether to check now. `enabled` is expo-updates' own (false in a build without it, or a dev
 * client); `isDev` is `__DEV__`; `inFlight` a check or download this app started that has not
 * finished; `lastCheckAt` when the last check started (ms, null for never).
 */
export function shouldCheck(o: { enabled: boolean; isDev: boolean; inFlight: boolean; reason: CheckReason; lastCheckAt: number | null; now: number }): boolean {
  if (!o.enabled || o.isDev || o.inFlight) return false
  if (o.reason === 'launch' || o.lastCheckAt === null) return true
  return o.now - o.lastCheckAt >= FOREGROUND_CHECK_INTERVAL_MS
}

/** Whether the banner shows: an update is downloaded and waiting, and Later was not tapped for that one. */
export function bannerVisible(o: { pendingUpdateId: string | null; dismissedUpdateId: string | null }): boolean {
  return o.pendingUpdateId !== null && o.pendingUpdateId !== o.dismissedUpdateId
}
