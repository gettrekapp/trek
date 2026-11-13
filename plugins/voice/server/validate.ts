// The voice methods' parameters, checked before anything reaches ElevenLabs or the config file.
import { optionalFlag, pluginError } from '../../../src/shared/plugins/server.ts'
import { MAX_SPOKEN_CHARS, type VoiceServerConfig } from '../shared/types.ts'

const bad = (message: string): Error => pluginError('BAD_REQUEST', message)

/** An ElevenLabs voice id (alphanumeric; it goes into the request's path, encoded too). */
const VOICE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/
const MODEL_ID_RE = /^[A-Za-z0-9_.-]{1,128}$/

export function requireVoicePatch(p: Record<string, unknown>): Partial<VoiceServerConfig> {
  const patch: Partial<VoiceServerConfig> = {}
  for (const key of Object.keys(p)) {
    if (key !== 'voiceId' && key !== 'modelId' && key !== 'promptSessions') throw bad(`${key} is not a voice setting`)
  }
  if (p.voiceId !== undefined) {
    if (typeof p.voiceId !== 'string' || !VOICE_ID_RE.test(p.voiceId)) throw bad('voiceId must be an ElevenLabs voice id')
    patch.voiceId = p.voiceId
  }
  if (p.modelId !== undefined) {
    if (typeof p.modelId !== 'string' || !MODEL_ID_RE.test(p.modelId)) throw bad('modelId must be an ElevenLabs model id')
    patch.modelId = p.modelId
  }
  if (p.promptSessions !== undefined) patch.promptSessions = optionalFlag(p.promptSessions, 'promptSessions')
  return patch
}

/** The text to speak: trimmed, not empty, at most MAX_SPOKEN_CHARS. */
export function requireSpokenText(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw bad(`${field} is required`)
  const text = value.trim()
  if (text.length > MAX_SPOKEN_CHARS) {
    throw bad(`${field} is ${text.length} characters; keep it to one to three short sentences (at most ${MAX_SPOKEN_CHARS})`)
  }
  return text
}
