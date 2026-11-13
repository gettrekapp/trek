// The voice plugin's wire types (phase 5b's voice.*, unchanged on the wire): its methods'
// results and the `voice.summary` event.

export interface VoiceInfo {
  id: string
  name: string
}

/** `present`: a set-if-absent (the app's hand-over) found a key already stored, and kept it. */
export type VoiceKeyResult = { ok: true; voices: VoiceInfo[] } | { ok: false; error: string; present?: true }

/** A server's ElevenLabs settings: its voice and model, and whether sessions are told to speak. */
export interface VoiceServerConfig {
  voiceId: string
  modelId: string
  /** Tell agent sessions to call speak_summary on their own when they finish or need the user. */
  promptSessions: boolean
}

export interface VoiceServerSettings extends VoiceServerConfig {
  hasKey: boolean
}

/** `voice.summary`: a session's spoken summary, to the windows that have its project open. */
export interface VoiceSummaryEvent {
  projectId: string
  /** The session that spoke (its terminalId) */
  sessionId: string
  text: string
  /** The mp3, base64 */
  audio: string
}

/** The longest text synthesized (the speak_summary tool's limit): one to three short sentences. */
export const MAX_SPOKEN_CHARS = 400
