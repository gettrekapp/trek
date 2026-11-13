// The voice plugin's state in this window: its server's settings with this app's Active/Busy, and
// what is playing. (The app store's voice fields before plugin system phase 1.)
import { create } from 'zustand'
import type { VoiceServerConfig } from '../shared/types.ts'

/** A window's view of voice summaries: its server's voice, model and "Summarize automatically", with this app's Active/Busy. */
export interface VoiceConfig extends VoiceServerConfig {
  /** Active plays spoken summaries in this app's windows; Busy (false) drops them. */
  active: boolean
}

export interface VoiceSettings extends VoiceConfig {
  /** The window's server has an ElevenLabs key */
  hasApiKey: boolean
}

export interface SpokenSummary {
  /** The session that spoke; '' for Settings' Test */
  terminalId: string
  text: string
}

interface VoiceState {
  /** The window's server's settings, null until loaded (or without a project) */
  settings: VoiceSettings | null
  /** This app's Active/Busy (its prefs), apart from `settings`: null until loaded (not active) */
  active: boolean | null
  playing: SpokenSummary | null
  queued: number
  setSettings(settings: VoiceSettings | null): void
  setActive(active: boolean): void
  setPlayback(playing: SpokenSummary | null, queued: number): void
}

export const useVoiceStore = create<VoiceState>((set) => ({
  settings: null,
  active: null,
  playing: null,
  queued: 0,
  setSettings: (settings) => set({ settings }),
  // The Settings section's copy (`settings.active`) follows it.
  setActive: (active) => set((s) => ({ active, settings: s.settings && s.settings.active !== active ? { ...s.settings, active } : s.settings })),
  setPlayback: (playing, queued) => set({ playing, queued })
}))
