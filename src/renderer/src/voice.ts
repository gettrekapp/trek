import { useAppStore, type SpokenSummary } from './store'
import type { VoiceConfig } from '../../shared/types'

/**
 * Spoken summaries from Claude sessions (the speak_summary MCP tool),
 * synthesized by ElevenLabs in the main process. Clips play one at a time,
 * in arrival order, and only while the app is set to Active.
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

function stopAllSummaries(): void {
  queue.splice(0).forEach((c) => URL.revokeObjectURL(c.url))
  stopSummary()
  publish()
}

export async function loadVoiceSettings(): Promise<void> {
  useAppStore.getState().setVoice(await window.api.voiceGetSettings())
}

export async function updateVoiceConfig(patch: Partial<VoiceConfig>): Promise<void> {
  const config = await window.api.voiceSetConfig(patch)
  const voice = useAppStore.getState().voice
  useAppStore.getState().setVoice({ hasApiKey: voice?.hasApiKey ?? false, ...config })
  if (!config.active) stopAllSummaries()
}

export const voiceReady = (): boolean => !!useAppStore.getState().voice?.hasApiKey

const isActive = (): boolean => useAppStore.getState().voice?.active !== false

export type SpeakResult =
  | { played: true; position: number }
  | { played: false; reason: string }

/** Synthesizes a summary and queues it, unless the user is Busy. */
export async function speakSummary(terminalId: string, text: string): Promise<SpeakResult> {
  const busy: SpeakResult = { played: false, reason: 'The user is Busy, so it was not played' }
  if (!isActive()) return busy
  const audio = await window.api.voiceSynthesize(text)
  // The user may have gone Busy while it was synthesizing.
  if (!isActive()) return busy
  const url = URL.createObjectURL(new Blob([audio as BlobPart], { type: 'audio/mpeg' }))
  queue.push({ terminalId, text, url })
  const position = queue.length + (current ? 1 : 0) - 1
  playNext()
  return { played: true, position }
}
