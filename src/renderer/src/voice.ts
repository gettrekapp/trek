import { useEffect } from 'react'
import { useAppStore, type SpokenSummary } from './store'
import { getBackend } from './backend'
import { useFeatures } from './useFeatures'
import { base64Bytes } from './v2/backendV2'
import { admitsClip, followAppActive, isPresenceActive, mergeVoice } from './voicePresence'
import type { VoiceConfig, VoiceSettings } from '../../shared/types'

/**
 * Spoken summaries from agent sessions (the speak_summary MCP tool). Since 5b the
 * window's server synthesizes them with its ElevenLabs key and sends each clip
 * to every window that has the project open (`voice.summary`); this window
 * plays them one at a time, in arrival order, and only while this app is set
 * to Active (an app-wide setting, `voiceActive`: the user's presence here, not
 * the server's). The key, voice, model and "Summarize automatically" are the
 * server's.
 */

export const MAX_SUMMARY_CHARS = 400

interface Clip extends SpokenSummary {
  url: string
}

const queue: Clip[] = []
let current: { clip: Clip; audio: HTMLAudioElement } | null = null

function publish(): void {
  const playing = current ? { terminalId: current.clip.terminalId, text: current.clip.text } : null
  useAppStore.getState().setVoicePlayback(playing, queue.length)
}

function playNext(): void {
  if (current) return
  const clip = queue.shift()
  if (!clip) return publish()
  const audio = new Audio(clip.url)
  current = { clip, audio }
  const finish = (): void => {
    if (current?.audio !== audio) return
    URL.revokeObjectURL(clip.url)
    current = null
    playNext()
  }
  audio.onended = finish
  audio.onerror = finish
  publish()
  audio.play().catch(finish)
}

/** Stops the summary playing now; the next queued one starts. */
export function stopSummary(): void {
  if (!current) return
  current.audio.pause()
  URL.revokeObjectURL(current.clip.url)
  current = null
  playNext()
}

/** Stops the summary playing and drops the queued ones (a server window takes over, or leaves). */
export function stopAllSummaries(): void {
  queue.splice(0).forEach((c) => URL.revokeObjectURL(c.url))
  stopSummary()
  publish()
}

/** This app's Active/Busy (its own store field, not the server's voice settings): not active until loaded. */
const isActive = (): boolean => isPresenceActive(useAppStore.getState().voiceActive)

/** Queues a clip to play; its position in the queue (0: playing now), or null when the queue is full (dropped). */
function enqueue(terminalId: string, text: string, audio: Uint8Array): number | null {
  if (!admitsClip(queue.length)) return null
  const url = URL.createObjectURL(new Blob([audio as BlobPart], { type: 'audio/mpeg' }))
  queue.push({ terminalId, text, url })
  const position = queue.length + (current ? 1 : 0) - 1
  playNext()
  return position
}

/**
 * The window's server's voice settings with this app's Active/Busy, or null
 * when the window's server has no voice (or the window has no project).
 */
export async function loadVoiceSettings(): Promise<void> {
  const backend = getBackend()
  if (!backend.features.voice) {
    useAppStore.getState().setVoice(null)
    return
  }
  const server = await backend.voice.settings()
  // The window moved to another server meanwhile: its own load wins.
  if (getBackend() !== backend) return
  const { hasKey, ...config } = server
  // Until the app's Active/Busy is loaded the section shows Active (the default); it follows.
  const voice: VoiceSettings = { ...config, hasApiKey: hasKey, active: useAppStore.getState().voiceActive !== false }
  useAppStore.getState().setVoice(voice)
}

/** `active` is this app's (app settings); the rest is the window's server's. */
export async function updateVoiceConfig(patch: Partial<VoiceConfig>): Promise<void> {
  const { active, ...server } = patch
  if (!useAppStore.getState().voice) return
  // Each result is merged into the settings as they are after its await, not a copy from before.
  const apply = (update: Partial<VoiceSettings>): void => {
    const next = mergeVoice(useAppStore.getState().voice, update)
    if (next) useAppStore.getState().setVoice(next)
  }
  if (active !== undefined) {
    const settings = await window.api.appSettings.update({ voiceActive: active })
    useAppStore.getState().setVoiceActive(settings.voiceActive)
    apply({ active: settings.voiceActive })
    if (!settings.voiceActive) stopAllSummaries()
  }
  if (Object.keys(server).length > 0) {
    const backend = getBackend()
    const config = await backend.voice.setConfig(server)
    if (getBackend() !== backend) return
    apply(config)
  }
}

export type SpeakResult = { played: true; position: number } | { played: false; reason: string }

/** Settings' Test: synthesized for this window only, and played unless the user is Busy. */
export async function testVoice(text: string): Promise<SpeakResult> {
  const busy: SpeakResult = { played: false, reason: 'The user is Busy, so it was not played' }
  if (!isActive()) return busy
  const backend = getBackend()
  const audio = await backend.voice.synthesize(text)
  // The window moved to another server meanwhile: not this one's clip.
  if (getBackend() !== backend) return { played: false, reason: "The window's server changed, so it was not played" }
  // The user may have gone Busy while it was synthesizing.
  if (!isActive()) return busy
  const position = enqueue('', text, audio)
  if (position === null) return { played: false, reason: 'Too many summaries are waiting to play, so it was not queued' }
  return { played: true, position }
}

/**
 * Keeps the window's voice settings for its server, plays the summaries the
 * server sends for its project, and follows the app's Active/Busy (changed in
 * any window).
 */
export function useVoice(): void {
  const features = useFeatures()
  // The app's Active/Busy, for as long as the window is open, whatever its server.
  useEffect(
    () =>
      followAppActive(window.api.appSettings, {
        set: (active) => useAppStore.getState().setVoiceActive(active),
        onBusy: stopAllSummaries
      }),
    []
  )
  useEffect(() => {
    const load = (): void => {
      void loadVoiceSettings().catch((err) => {
        console.warn('Voice settings could not be read', err)
        useAppStore.getState().setVoice(null)
      })
    }
    load()
    if (!features.voice) return
    const backend = getBackend()
    const offSummary = backend.voice.onSummary((event) => {
      if (!isActive()) return
      enqueue(event.sessionId, event.text, base64Bytes(event.audio))
    })
    // The key or voice set elsewhere (another window, the hand-over to the Local server).
    const offChanged = backend.voice.onChanged(load)
    return () => {
      offSummary()
      offChanged()
    }
  }, [features])
}
