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

/**
 * Whether a check's result has something to download: a new update, or the server's directive to
 * roll back to the bundle the build shipped with (`isAvailable` is false for that one).
 */
export function shouldFetch(result: { isAvailable: boolean; isRollBackToEmbedded?: boolean }): boolean {
  return result.isAvailable || result.isRollBackToEmbedded === true
}

/**
 * What the banner keys Later on: the downloaded update's id, or for a rollback (which has none)
 * its time; null while nothing is downloaded and waiting.
 */
export function pendingKey(o: { isUpdatePending: boolean; updateId?: string; createdAt?: Date }): string | null {
  if (!o.isUpdatePending) return null
  return o.updateId ?? `rollback:${o.createdAt?.getTime() ?? 0}`
}
