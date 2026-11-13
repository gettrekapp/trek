// The app's Linear and ElevenLabs keys and voice settings, handed to the Local server once (phase
// 5b): before 5b main kept them (safeStorage in userData), and the server cannot decrypt those
// files. Pure: the requests and the legacy values come in, so `node --test` covers it.
import { CAPABILITY } from '../shared/protocolV2.ts'

/** What a Local profile has been given already, by part. */
export interface HandoverDone {
  linear?: true
  voice?: true
  /** The key went over but its voice settings did not (the link dropped between the two): sent next time */
  voiceConfigPending?: true
}

/** `integrations-handover.json`: per Local profile, and the app's own Active/Busy once. */
export interface HandoverState {
  profiles: Record<string, HandoverDone>
  /** voice-settings.json's `active` was moved into the app settings */
  voiceActive?: true
}

/** The app's own files, decrypted. A key is null when none is stored. */
export interface LegacyIntegrations {
  linearKey: string | null
  voiceKey: string | null
  /**
   * A key that is stored but could not be read here (safeStorage refused to decrypt it, the file
   * is unreadable): that part is not done, and is tried again on the next start.
   */
  unreadable?: { linear?: true; voice?: true }
  voice: { voiceId?: unknown; modelId?: unknown; promptSessions?: unknown; active?: unknown }
}

/**
 * The parts the Local server can take: each part's plugin (plugin system phases 1–2), told by its
 * legacy capability (`linear`, `voice`). A part the server lacks waits for a later start; the other
 * goes over without it.
 */
export interface HandoverParts {
  linear: boolean
  voice: boolean
}

/** The parts a server's welcome capabilities say it takes. */
export function handoverParts(capabilities: readonly string[]): HandoverParts {
  return { linear: capabilities.includes(CAPABILITY.linear), voice: capabilities.includes(CAPABILITY.voice) }
}

/** The Local server's `linear.setKey`, `voice.setKey` and `voice.setConfig`. */
export type HandoverRequest = (method: 'linear.setKey' | 'voice.setKey' | 'voice.setConfig', params: Record<string, unknown>) => Promise<unknown>

export function parseHandoverState(raw: unknown): HandoverState {
  const from = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  const profiles: Record<string, HandoverDone> = {}
  const rawProfiles = from.profiles && typeof from.profiles === 'object' && !Array.isArray(from.profiles) ? (from.profiles as Record<string, unknown>) : {}
  for (const [name, value] of Object.entries(rawProfiles)) {
    if (!value || typeof value !== 'object') continue
    const v = value as Record<string, unknown>
    Object.defineProperty(profiles, name, {
      value: {
        ...(v.linear === true ? { linear: true } : {}),
        ...(v.voice === true ? { voice: true } : {}),
        ...(v.voice === true && v.voiceConfigPending === true ? { voiceConfigPending: true } : {})
      },
      enumerable: true,
      writable: true,
      configurable: true
    })
  }
  return { profiles, ...(from.voiceActive === true ? { voiceActive: true } : {}) }
}

/**
 * `integrations-handover.json` through `read` (its text): a missing file (ENOENT) is the empty
 * state. Any other failure (unreadable, not JSON) is `{ state: null, error }`: the caller then
 * does nothing that start (neither the hand-over nor the Active/Busy move) and writes nothing, so
 * a key the user cleared on the server is not handed over again and the file is not replaced.
 */
export function readHandoverState(read: () => string): { state: HandoverState; error?: undefined } | { state: null; error: unknown } {
  let text: string
  try {
    text = read()
  } catch (err) {
    if ((err as { code?: unknown } | null)?.code === 'ENOENT') return { state: parseHandoverState(undefined) }
    return { state: null, error: err }
  }
  try {
    return { state: parseHandoverState(JSON.parse(text)) }
  } catch (err) {
    return { state: null, error: err }
  }
}

/** The voice settings worth sending: a chosen voice, a model, the flag; nothing else. */
export function legacyVoiceConfig(voice: LegacyIntegrations['voice']): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (typeof voice.voiceId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(voice.voiceId)) out.voiceId = voice.voiceId
  if (typeof voice.modelId === 'string' && /^[A-Za-z0-9_.-]{1,128}$/.test(voice.modelId)) out.modelId = voice.modelId
  if (typeof voice.promptSessions === 'boolean') out.promptSessions = voice.promptSessions
  return out
}

const result = (value: unknown): { ok?: unknown; present?: unknown } => (value && typeof value === 'object' ? (value as { ok?: unknown; present?: unknown }) : {})

/**
 * Hands over what `done` lacks; resolves what is done now. A part is done when there is nothing to
 * hand over (no key stored: one stored but unreadable here is not "nothing"), whatever `parts`
 * says; when the server took it (`ok`); or when it already had a key of its own (`present`: the
 * user set one there, which wins). A part with a key whose plugin the server lacks (`parts`) waits
 * for a later start. Anything else (a server older than 5b, a dropped link, a secrets file it
 * cannot write) leaves it for the next start. The server stores a hand-over key
 * without asking Linear or ElevenLabs (`ifAbsent`), so neither needs to be reachable. The voice settings go only with a key
 * the server took: a server with its own key keeps its own voice too. Settings that fail after
 * their key went are pending, and sent on the next start.
 */
/** Nothing to send for any part: no key stored, and none stored but unreadable. */
export function nothingToHandOver(legacy: LegacyIntegrations): boolean {
  return !legacy.linearKey && !legacy.voiceKey && !legacy.unreadable?.linear && !legacy.unreadable?.voice
}

export async function handOver(
  request: HandoverRequest,
  legacy: LegacyIntegrations,
  done: HandoverDone,
  parts: HandoverParts = { linear: true, voice: true }
): Promise<HandoverDone> {
  const next: HandoverDone = { ...done }
  const attempt = async <T>(run: () => Promise<T>): Promise<T | false> => {
    try {
      return await run()
    } catch {
      return false
    }
  }
  if (!next.linear && !legacy.unreadable?.linear && !legacy.linearKey) next.linear = true
  else if (parts.linear && !next.linear && !legacy.unreadable?.linear) {
    const ok = await attempt(async () => {
      const r = result(await request('linear.setKey', { apiKey: legacy.linearKey, ifAbsent: true }))
      return r.ok === true || r.present === true
    })
    if (ok) next.linear = true
  }
  const config = legacyVoiceConfig(legacy.voice)
  const sendConfig = (): Promise<boolean> => attempt(async () => {
    if (Object.keys(config).length > 0) await request('voice.setConfig', config)
    return true
  })
  const voiceKey = legacy.voiceKey
  if (!next.voice && !legacy.unreadable?.voice && !voiceKey) {
    // No key: nothing to send, so done (its settings go only with a key the server took).
    next.voice = true
  } else if (!parts.voice) {
    // Nothing of voice's this time, a pending config included.
  } else if (!next.voice && !legacy.unreadable?.voice && voiceKey) {
    const stored = await attempt(async () => {
      const r = result(await request('voice.setKey', { apiKey: voiceKey, ifAbsent: true }))
      if (r.present === true) return 'kept'
      return r.ok === true ? 'stored' : false
    }) as 'kept' | 'stored' | false
    if (stored) {
      next.voice = true
      if (stored === 'stored' && !(await sendConfig())) next.voiceConfigPending = true
    }
  } else if (next.voiceConfigPending && (await sendConfig())) delete next.voiceConfigPending
  return next
}
