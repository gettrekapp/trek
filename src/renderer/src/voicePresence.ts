// This app's voice Active/Busy as the window knows it (phase 5b): an app setting (`voiceActive`),
// the user's presence here, kept apart from the window's server's voice settings, which can be
// null (no project yet, a server without voice) while summaries still arrive. Pure: the app
// settings API comes in, so `node --test` covers it.

import type { VoiceSettings } from '../../shared/types'

/** Clips waiting behind the one playing; more are dropped (an agent in a loop cannot pile up audio). */
export const MAX_QUEUED_CLIPS = 5

/** A clip is queued only while fewer than MAX_QUEUED_CLIPS are waiting. */
export const admitsClip = (waiting: number): boolean => waiting < MAX_QUEUED_CLIPS

/**
 * An update merged into the window's voice settings as they are now (read after the update's
 * awaits, so a load that landed meanwhile is kept); null when the window has none any more.
 */
export const mergeVoice = (now: VoiceSettings | null, update: Partial<VoiceSettings>): VoiceSettings | null => (now ? { ...now, ...update } : null)

interface AppSettingsApi {
  get: () => Promise<{ voiceActive: boolean }>
  onChanged: (callback: (settings: { voiceActive: boolean }) => void) => () => void
}

/** Active only once known: a clip that arrives before the app settings answer is dropped. */
export const isPresenceActive = (voiceActive: boolean | null): boolean => voiceActive === true

/**
 * Loads `voiceActive` and follows its changes (made in any window) into `set`; `onBusy` on a change
 * to Busy. A change heard before the load answers wins over it; a load that fails is Active (as the
 * app settings' default). Returns the unsubscribe.
 */
export function followAppActive(api: AppSettingsApi, to: { set: (active: boolean) => void; onBusy: () => void }): () => void {
  let heard = false
  let stopped = false
  const off = api.onChanged((settings) => {
    if (stopped) return
    heard = true
    to.set(settings.voiceActive)
    if (!settings.voiceActive) to.onBusy()
  })
  api.get().then(
    (settings) => {
      if (!stopped && !heard) to.set(settings.voiceActive !== false)
    },
    () => {
      if (!stopped && !heard) to.set(true)
    }
  )
  return () => {
    stopped = true
    off()
  }
}
