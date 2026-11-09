// Linear with the server's own API key (phase 5b; capability `linear`). Before 5b the app's main
// process kept one key for every window; now each server has its own, in its secrets file
// (secrets.ts), set from any client and never sent back.
import type { V2Context } from '../v2.ts'
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
  }
}
