// Linear and ElevenLabs with the server's own API keys, and the skills on its disk (phase 5b;
// capabilities `linear`, `voice` and `skills`). Before 5b the app's main process kept one key of each for every window; now each server
// has its own, in its secrets file (secrets.ts), set from any client and never sent back.
import { MAX_SPOKEN_CHARS } from '../../../src/host/voiceService.ts'
import type { VoiceServerConfig } from '../../../src/shared/types'
import type { V2Context } from '../v2.ts'
import { present } from '../worktreeHandlers.ts'
import { codedError } from '../errors.ts'
import type { Integrations } from './integrations.ts'

type Handler = (params: any, ctx: V2Context) => unknown

const bad = (message: string): Error => codedError('BAD_REQUEST', message)

const MAX_KEY = 1024
const MAX_IDS = 500
const MAX_ID = 64

/** An API key: trimmed, not empty, printable, no whitespace inside (it goes into an HTTP header). */
export function requireApiKey(value: unknown): string {
  if (typeof value !== 'string') throw bad('apiKey must be a string')
  const key = value.trim()
  if (!key) throw bad('apiKey is required')
  if (key.length > MAX_KEY) throw bad(`apiKey must be at most ${MAX_KEY} characters`)
  if (!/^[\x21-\x7e]+$/.test(key)) throw bad('apiKey must be printable ASCII with no spaces')
  return key
}

export function optionalFlag(value: unknown, field: string): boolean {
  if (value === undefined) return false
  if (typeof value !== 'boolean') throw bad(`${field} must be a boolean`)
  return value
}

function requireIssueIds(value: unknown): string[] {
  if (!Array.isArray(value)) throw bad('ids must be an array of strings')
  if (value.length > MAX_IDS) throw bad(`ids: at most ${MAX_IDS}`)
  for (const id of value) if (typeof id !== 'string' || id.length > MAX_ID) throw bad(`ids must be strings of at most ${MAX_ID} characters`)
  return value as string[]
}

/** An ElevenLabs voice id (alphanumeric; it goes into the request's path, encoded too). */
const VOICE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/
const MODEL_ID_RE = /^[A-Za-z0-9_.-]{1,128}$/

function requireVoicePatch(p: Record<string, unknown>): Partial<VoiceServerConfig> {
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

export const integrations = (ctx: V2Context): Integrations => {
  if (!ctx.integrations) throw codedError('NOT_FOUND', 'this server has no integrations')
  return ctx.integrations
}

/** A failed lookup (Linear down, the secrets file unreadable) is TOOL_ERROR, never INTERNAL; a coded refusal stays as it is. */
export async function viaService<T>(operation: () => T | Promise<T>): Promise<T> {
  try {
    return await operation()
  } catch (err) {
    const code = (err as { code?: unknown }).code
    if (code === 'BAD_REQUEST' || code === 'NOT_FOUND') throw err
    throw codedError('TOOL_ERROR', (err as Error).message ?? String(err))
  }
}

export const integrationHandlers: Record<string, Handler> = {
  'linear.status': (_p, ctx) => viaService(() => ({ hasKey: integrations(ctx).linear.hasKey() })),

  'linear.setKey': (p, ctx) => {
    const apiKey = requireApiKey(p.apiKey)
    const ifAbsent = optionalFlag(p.ifAbsent, 'ifAbsent')
    return integrations(ctx).linear.setKey(apiKey, { ifAbsent })
  },

  'linear.clearKey': (_p, ctx) =>
    viaService(() => {
      integrations(ctx).linear.clearKey()
      return null
    }),

  'linear.issues': (p, ctx) => {
    const ids = requireIssueIds(p.ids)
    return viaService(() => integrations(ctx).linear.issues(ids))
  },

  'voice.settings': (_p, ctx) => viaService(() => integrations(ctx).voice.settings()),

  'voice.setKey': (p, ctx) => {
    const apiKey = requireApiKey(p.apiKey)
    const ifAbsent = optionalFlag(p.ifAbsent, 'ifAbsent')
    return integrations(ctx).voice.setKey(apiKey, { ifAbsent })
  },

  'voice.clearKey': (_p, ctx) =>
    viaService(() => {
      integrations(ctx).voice.clearKey()
      return null
    }),

  'voice.voices': (_p, ctx) => viaService(() => integrations(ctx).voice.voices()),

  'voice.setConfig': (p, ctx) => {
    const patch = requireVoicePatch(p)
    return viaService(() => integrations(ctx).voice.setConfig(patch))
  },

  // The worktree's path from the server's state, checked as the worktree commands check it.
  'skills.list': (p, ctx) => {
    const { worktree } = present(ctx, p)
    return viaService(() => integrations(ctx).skills.list(worktree.path))
  },

  'voice.synthesize': (p, ctx) => {
    const text = requireSpokenText(p.text, 'text')
    return viaService(async () => ({ audio: Buffer.from(await integrations(ctx).voice.synthesize(text)).toString('base64') }))
  }
}
