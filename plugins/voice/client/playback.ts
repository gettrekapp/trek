// Spoken summaries from agent sessions (the speak_summary MCP tool). The window's server
// synthesizes them with its ElevenLabs key and sends each clip to every window that has the
// project open (`voice.summary`); this window plays them one at a time, in arrival order, and only
// while this app is set to Active (the plugin's per-app pref: the user's presence here, not the
// server's). The key, voice, model and "Summarize automatically" are the server's.
import type { ClientPluginHost } from '../../../src/shared/plugins/client.ts'
import type { VoiceKeyResult, VoiceServerConfig, VoiceServerSettings } from '../shared/types.ts'
import { activeIn, admitsClip, isPresenceActive, mergeVoice } from './presence.ts'
import { useVoiceStore, type SpokenSummary, type VoiceConfig, type VoiceSettings } from './store.ts'

interface Clip extends SpokenSummary {
  url: string
}

const queue: Clip[] = []
let current: { clip: Clip; audio: HTMLAudioElement } | null = null

function publish(): void {
  const playing = current ? { terminalId: current.clip.terminalId, text: current.clip.text } : null
  useVoiceStore.getState().setPlayback(playing, queue.length)
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

/** Stops the summary playing and drops the queued ones (the window leaves the project, or goes Busy). */
export function stopAllSummaries(): void {
  queue.splice(0).forEach((c) => URL.revokeObjectURL(c.url))
  stopSummary()
  publish()
}

/** This app's Active/Busy: not active until loaded. */
const isActive = (): boolean => isPresenceActive(useVoiceStore.getState().active)

/** A base64 mp3 as bytes. */
export function base64Bytes(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/** Queues a clip to play; its position in the queue (0: playing now), or null when the queue is full (dropped). */
export function enqueue(terminalId: string, text: string, audio: Uint8Array): number | null {
  if (!admitsClip(queue.length)) return null
  const url = URL.createObjectURL(new Blob([audio as BlobPart], { type: 'audio/mpeg' }))
  queue.push({ terminalId, text, url })
  const position = queue.length + (current ? 1 : 0) - 1
  playNext()
  return position
}

/** The window's server's voice settings with this app's Active/Busy. */
export async function loadVoiceSettings(host: ClientPluginHost): Promise<void> {
  const server = await host.request<VoiceServerSettings>('settings')
  // The window moved to another server meanwhile: its own load wins.
  if (!host.isCurrent()) return
  const { hasKey, ...config } = server
  // Until the app's Active/Busy is loaded the section shows Active (the default); it follows.
  const voice: VoiceSettings = { ...config, hasApiKey: hasKey, active: useVoiceStore.getState().active !== false }
  useVoiceStore.getState().setSettings(voice)
}

/** `active` is this app's (the plugin's prefs); the rest is the window's server's. */
export async function updateVoiceConfig(host: ClientPluginHost, patch: Partial<VoiceConfig>): Promise<void> {
  const { active, ...server } = patch
  if (!useVoiceStore.getState().settings) return
  // Each result is merged into the settings as they are after its await, not a copy from before.
  const apply = (update: Partial<VoiceSettings>): void => {
    const next = mergeVoice(useVoiceStore.getState().settings, update)
    if (next) useVoiceStore.getState().setSettings(next)
  }
  if (active !== undefined) {
    const now = activeIn(await host.prefs.set('active', active))
    useVoiceStore.getState().setActive(now)
    apply({ active: now })
    if (!now) stopAllSummaries()
  }
  if (Object.keys(server).length > 0) {
    const config = await host.request<VoiceServerConfig>('setConfig', server)
    if (!host.isCurrent()) return
    apply(config)
  }
}

export const setVoiceKey = (host: ClientPluginHost, apiKey: string): Promise<VoiceKeyResult> => host.request<VoiceKeyResult>('setKey', { apiKey })

export type SpeakResult = { played: true; position: number } | { played: false; reason: string }

/** Settings' Test: synthesized for this window only, and played unless the user is Busy. */
export async function testVoice(host: ClientPluginHost, text: string): Promise<SpeakResult> {
  const busy: SpeakResult = { played: false, reason: 'The user is Busy, so it was not played' }
  if (!isActive()) return busy
  const { audio } = await host.request<{ audio: string }>('synthesize', { text })
  // The window moved to another server meanwhile: not this one's clip.
  if (!host.isCurrent()) return { played: false, reason: "The window's server changed, so it was not played" }
  // The user may have gone Busy while it was synthesizing.
  if (!isActive()) return busy
  const position = enqueue('', text, base64Bytes(audio))
  if (position === null) return { played: false, reason: 'Too many summaries are waiting to play, so it was not queued' }
  return { played: true, position }
}
