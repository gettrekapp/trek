// ElevenLabs voice summaries with the server's API key (phase 5b; main's voice.ts before it).
// Electron-free: the key is in a slot the caller owns (the server's secrets file), the voice and
// model in a JSON file, and the API's base URL can be pointed at a test's stub server.
import { readFileSync } from 'node:fs'
import type { VoiceInfo, VoiceKeyResult, VoiceServerConfig, VoiceServerSettings } from '../shared/types'
import { writeFileAtomic } from './atomicWrite.ts'
import { MAX_AUDIO_BYTES, MAX_ERROR_BYTES, MAX_JSON_BYTES, readBodyCapped } from './httpBody.ts'
import { PRESENT_ERROR, type KeySlot } from './linearService.ts'

export const ELEVENLABS_API = 'https://api.elevenlabs.io/v1'
/** The longest text synthesized (the speak_summary tool's limit): one to three short sentences. */
export const MAX_SPOKEN_CHARS = 400
const TIMEOUT_MS = 30_000

export const DEFAULT_VOICE_CONFIG: Readonly<VoiceServerConfig> = Object.freeze({
  voiceId: '',
  modelId: 'eleven_flash_v2_5',
  promptSessions: false
})

export interface VoiceService {
  settings(): VoiceServerSettings
  /**
   * Checks the key by listing its voices, stores it and picks the first voice if none is chosen.
   * `ifAbsent` (the app's hand-over, which sends its voice next): stored as it is, without asking
   * ElevenLabs, only while no key is stored; else `{ ok: false, present: true }`. Its `voices` are then empty.
   * `{ ok: false, error }` is only ElevenLabs' answer; a key slot that cannot be read (checked
   * before any request) or written throws, as does a stored key whose first voice cannot be saved.
   */
  setKey(apiKey: string, options?: { ifAbsent?: boolean }): Promise<VoiceKeyResult>
  clearKey(): void
  voices(): Promise<VoiceInfo[]>
  setConfig(patch: Partial<VoiceServerConfig>): VoiceServerConfig
  /** An mp3 of `text` in the chosen voice */
  synthesize(text: string): Promise<Uint8Array>
  /** Sessions are told to speak: a key is set, a voice is chosen and "Summarize automatically" is on */
  promptSessions(): boolean
}

export function createVoiceService(options: { key: KeySlot; configFile: string; api?: string; fetch?: typeof fetch }): VoiceService {
  const api = options.api ?? ELEVENLABS_API
  const doFetch = options.fetch ?? fetch

  /** A missing or unreadable file is the defaults (it holds no secret); known fields of the right type are kept. */
  const readConfig = (): VoiceServerConfig => {
    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(options.configFile, 'utf8'))
    } catch {
      return { ...DEFAULT_VOICE_CONFIG }
    }
    const from = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
    return {
      voiceId: typeof from.voiceId === 'string' ? from.voiceId : DEFAULT_VOICE_CONFIG.voiceId,
      modelId: typeof from.modelId === 'string' && from.modelId ? from.modelId : DEFAULT_VOICE_CONFIG.modelId,
      promptSessions: typeof from.promptSessions === 'boolean' ? from.promptSessions : DEFAULT_VOICE_CONFIG.promptSessions
    }
  }

  const setConfig = (patch: Partial<VoiceServerConfig>): VoiceServerConfig => {
    const next = { ...readConfig(), ...patch }
    writeFileAtomic(options.configFile, JSON.stringify(next, null, 2) + '\n', 0o600)
    return next
  }

  async function request(apiKey: string, path: string, init: RequestInit = {}): Promise<Response> {
    const res = await doFetch(`${api}${path}`, {
      ...init,
      headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json', ...init.headers },
      signal: AbortSignal.timeout(TIMEOUT_MS)
    })
    if (res.status === 401) throw new Error('ElevenLabs rejected the API key')
    if (!res.ok) {
      // An error text over the cap is left out: the status still says what failed.
      const body = await readBodyCapped(res, MAX_ERROR_BYTES, "ElevenLabs' error")
        .then((bytes) => bytes.toString('utf8'))
        .catch(() => '')
      throw new Error(`ElevenLabs returned ${res.status}${body ? `: ${body.slice(0, 300)}` : ''}`)
    }
    return res
  }

  async function fetchVoices(apiKey: string): Promise<VoiceInfo[]> {
    const res = await request(apiKey, '/voices')
    const { voices } = JSON.parse((await readBodyCapped(res, MAX_JSON_BYTES, "ElevenLabs' voice list")).toString('utf8')) as {
      voices?: { voice_id: unknown; name: unknown }[]
    }
    return (Array.isArray(voices) ? voices : []).map((v) => ({ id: String(v.voice_id), name: String(v.name) }))
  }

  const requireKey = (): string => {
    const apiKey = options.key.get()
    if (!apiKey) throw new Error('No ElevenLabs API key is set on this server')
    return apiKey
  }

  return {
    settings: () => ({ ...readConfig(), hasKey: !!options.key.get() }),

    async setKey(apiKey, { ifAbsent = false } = {}) {
      if (ifAbsent) return options.key.setIfAbsent(apiKey) ? { ok: true, voices: [] } : { ok: false, error: PRESENT_ERROR, present: true }
      // An unreadable secrets file fails here, before ElevenLabs sees the key.
      options.key.get()
      let voices: VoiceInfo[]
      try {
        voices = await fetchVoices(apiKey)
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
      // Outside the try: a failed write is the server's error, not a rejected key.
      options.key.set(apiKey)
      if (!readConfig().voiceId && voices[0]) {
        // The key is stored by now, so `ok: false` would be untrue (Settings would ask for it
        // again) and `ok: true` would hide that no voice is chosen (speak_summary is not set up
        // without one). Throw (TOOL_ERROR) saying both.
        try {
          setConfig({ voiceId: voices[0].id })
        } catch (err) {
          throw new Error(`The key was stored, but the voice could not be saved: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
      return { ok: true, voices }
    },

    clearKey: () => options.key.set(null),

    voices: () => fetchVoices(requireKey()),

    setConfig,

    async synthesize(text) {
      const apiKey = requireKey()
      const { voiceId, modelId } = readConfig()
      if (!voiceId) throw new Error('No ElevenLabs voice is selected on this server')
      const res = await request(apiKey, `/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`, {
        method: 'POST',
        headers: { Accept: 'audio/mpeg' },
        body: JSON.stringify({ text, model_id: modelId })
      })
      return new Uint8Array(await readBodyCapped(res, MAX_AUDIO_BYTES, "ElevenLabs' clip"))
    },

    promptSessions: () => {
      try {
        const config = readConfig()
        return config.promptSessions && !!config.voiceId && !!options.key.get()
      } catch {
        // An unreadable secrets file: launch the session without the prompt.
        return false
      }
    }
  }
}
