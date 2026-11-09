import { useEffect } from 'react'
import { useAppStore, type SpokenSummary } from './store'
import { getBackend } from './backend'
import { useFeatures } from './useFeatures'
import { base64Bytes } from './v2/backendV2'
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

const isActive = (): boolean => useAppStore.getState().voice?.active !== false

/** Queues a clip to play; its position in the queue (0: playing now). */
function enqueue(terminalId: string, text: string, audio: Uint8Array): number {
  const url = URL.createObjectURL(new Blob([audio as BlobPart], { type: 'audio/mpeg' }))
  queue.push({ terminalId, text, url })
  const position = queue.length + (current ? 1 : 0) - 1
  playNext()
  return position
}

/** This app's Active/Busy, from the app settings (true when they cannot be read). */
async function appActive(): Promise<boolean> {
  try {
    return (await window.api.appSettings.get()).voiceActive !== false
  } catch {
    return true
  }
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
  const [server, active] = await Promise.all([backend.voice.settings(), appActive()])
  // The window moved to another server meanwhile: its own load wins.
  if (getBackend() !== backend) return
  const { hasKey, ...config } = server
  const voice: VoiceSettings = { ...config, hasApiKey: hasKey, active }
  useAppStore.getState().setVoice(voice)
}

/** `active` is this app's (app settings); the rest is the window's server's. */
export async function updateVoiceConfig(patch: Partial<VoiceConfig>): Promise<void> {
  const { active, ...server } = patch
  const before = useAppStore.getState().voice
  if (!before) return
  let next: VoiceSettings = { ...before }
  if (active !== undefined) {
    const settings = await window.api.appSettings.update({ voiceActive: active })
    next = { ...next, active: settings.voiceActive }
  }
  if (Object.keys(server).length > 0) {
    const backend = getBackend()
    const config = await backend.voice.setConfig(server)
    if (getBackend() !== backend) return
    next = { ...next, ...config }
  }
  useAppStore.getState().setVoice(next)
  if (!next.active) stopAllSummaries()
}

export type SpeakResult = { played: true; position: number } | { played: false; reason: string }

/** Settings' Test: synthesized for this window only, and played unless the user is Busy. */
export async function testVoice(text: string): Promise<SpeakResult> {
  const busy: SpeakResult = { played: false, reason: 'The user is Busy, so it was not played' }
  if (!isActive()) return busy
  const audio = await getBackend().voice.synthesize(text)
  // The user may have gone Busy while it was synthesizing.
  if (!isActive()) return busy
  return { played: true, position: enqueue('', text, audio) }
}

/**
 * Keeps the window's voice settings for its server, plays the summaries the
 * server sends for its project, and follows the app's Active/Busy (changed in
 * any window).
 */
export function useVoice(): void {
  const features = useFeatures()
  useEffect(() => {
    void loadVoiceSettings().catch((err) => {
      console.warn('Voice settings could not be read', err)
      useAppStore.getState().setVoice(null)
    })
    if (!features.voice) return
    const offSummary = getBackend().voice.onSummary((event) => {
      if (!isActive()) return
      enqueue(event.sessionId, event.text, base64Bytes(event.audio))
    })
    const offSettings = window.api.appSettings.onChanged((settings) => {
      const voice = useAppStore.getState().voice
      if (!voice || voice.active === settings.voiceActive) return
      useAppStore.getState().setVoice({ ...voice, active: settings.voiceActive })
      if (!settings.voiceActive) stopAllSummaries()
    })
    return () => {
      offSummary()
      offSettings()
    }
  }, [features])
}
