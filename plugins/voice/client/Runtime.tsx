// The voice plugin's Runtime, once per project window: keeps the window's voice settings for its
// server, plays the summaries the server sends for its project, and follows this app's Active/Busy
// (changed in any window). Unmounted when the window leaves the project: what plays stops.
import { useEffect } from 'react'
import { usePluginHost } from '../../../src/shared/plugins/client.ts'
import type { VoiceSummaryEvent } from '../shared/types.ts'
import { base64Bytes, enqueue, isActive, loadVoiceSettings, stopAllSummaries } from './playback.ts'
import { followAppActive } from './presence.ts'
import { useVoiceStore } from './store.ts'

export function VoiceRuntime(): null {
  const host = usePluginHost()
  useEffect(
    () =>
      followAppActive(host.prefs, {
        set: (active) => useVoiceStore.getState().setActive(active),
        onBusy: stopAllSummaries
      }),
    [host]
  )
  useEffect(() => {
    // A load that answers after the Runtime unmounted (the plugin turned off) is dropped.
    let cancelled = false
    const load = (): void => {
      void loadVoiceSettings(host, () => cancelled).catch((err) => {
        console.warn('Voice settings could not be read', err)
        if (!cancelled && host.isCurrent()) useVoiceStore.getState().setSettings(null)
      })
    }
    load()
    const offSummary = host.onEvent<VoiceSummaryEvent>('summary', (event) => {
      if (!isActive()) return
      enqueue(event.sessionId, event.text, base64Bytes(event.audio))
    })
    // The key or voice set elsewhere (another window, the hand-over to the Local server).
    const offChanged = host.onChanged(load)
    return () => {
      cancelled = true
      offSummary()
      offChanged()
      stopAllSummaries()
      useVoiceStore.getState().setSettings(null)
    }
  }, [host])
  return null
}
