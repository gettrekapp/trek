// This app's voice Active/Busy as the window knows it (phase 5b): the plugin's per-app pref
// (`active`), the user's presence here, kept apart from the window's server's voice settings,
// which can be null (no project yet) while summaries still arrive. Pure: the prefs come in, so
// `node --test` covers it.
import type { PluginPrefValue } from '../../../src/shared/plugins/manifest.ts'
import type { VoiceSettings } from './store.ts'

/** Clips waiting behind the one playing; more are dropped (an agent in a loop cannot pile up audio). */
export const MAX_QUEUED_CLIPS = 5

/** A clip is queued only while fewer than MAX_QUEUED_CLIPS are waiting. */
export const admitsClip = (waiting: number): boolean => waiting < MAX_QUEUED_CLIPS

/**
 * An update merged into the window's voice settings as they are now (read after the update's
 * awaits, so a load that landed meanwhile is kept); null when the window has none any more.
 */
export const mergeVoice = (now: VoiceSettings | null, update: Partial<VoiceSettings>): VoiceSettings | null => (now ? { ...now, ...update } : null)

/** The plugin's prefs: `active` false is Busy; true, none yet or a value that is not a boolean is Active, the default. */
export const activeIn = (prefs: Record<string, PluginPrefValue>): boolean => (typeof prefs.active === 'boolean' ? prefs.active : true)

interface PrefsApi {
  load(): Promise<Record<string, PluginPrefValue>>
  onChange(listener: (prefs: Record<string, PluginPrefValue>) => void): () => void
}

/** Active only once known: a clip that arrives before the prefs answer is dropped. */
export const isPresenceActive = (active: boolean | null): boolean => active === true

/**
 * Loads Active/Busy and follows its changes (made in any window) into `set`; `onBusy` on a change
 * to Busy. A change heard before the load answers wins over it; a load that fails is Active (as
 * the default). Returns the unsubscribe.
 */
export function followAppActive(prefs: PrefsApi, to: { set: (active: boolean) => void; onBusy: () => void }): () => void {
  let heard = false
  let stopped = false
  const off = prefs.onChange((values) => {
    if (stopped) return
    heard = true
    const active = activeIn(values)
    to.set(active)
    if (!active) to.onBusy()
  })
  prefs.load().then(
    (values) => {
      if (!stopped && !heard) to.set(activeIn(values))
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
