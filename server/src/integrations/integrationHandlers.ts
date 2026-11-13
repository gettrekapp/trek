// Linear with the server's own API key, and the skills on its disk (phase 5b; capabilities
// `linear` and `skills`). Before 5b the app's main process kept one key for every window; now each
// server has its own, in its secrets file (secrets.ts), set from any client and never sent back.
// (ElevenLabs is the voice plugin's since plugin system phase 1: plugins/voice.)
import { optionalFlag, requireApiKey } from '../../../src/shared/plugins/server.ts'
import type { V2Context } from '../v2.ts'
import { present } from '../worktreeHandlers.ts'
import { codedError } from '../errors.ts'
import type { Integrations } from './integrations.ts'

type Handler = (params: any, ctx: V2Context) => unknown

const bad = (message: string): Error => codedError('BAD_REQUEST', message)

const MAX_IDS = 500
const MAX_ID = 64

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

/**
 * Any failure (Linear down or refusing, the secrets file unreadable or unwritable) is TOOL_ERROR with its message, never INTERNAL; only BAD_REQUEST and NOT_FOUND (no
 * integrations, a worktree that is not there) pass through as they are.
 */
export async function viaService<T>(operation: () => T | Promise<T>): Promise<T> {
  try {
    return await operation()
  } catch (err) {
    const code = (err as { code?: unknown }).code
    if (code === 'BAD_REQUEST' || code === 'NOT_FOUND') throw err
    throw codedError('TOOL_ERROR', (err as Error).message ?? String(err))
  }
}

/** A key the service stored (`{ ok: true }`), not one it refused or kept (`ifAbsent` with one present). */
const stored = (result: unknown): boolean => (result as { ok?: unknown } | null)?.ok === true

/** Runs `operation`, then tells every connection that `part` changed (only when `changed` says so). */
async function changing<T>(ctx: V2Context, part: 'linear', operation: () => T | Promise<T>, changed: (result: T) => boolean = () => true): Promise<T> {
  const result = await viaService(operation)
  if (changed(result)) ctx.integrationsChanged?.({ [part]: true })
  return result
}

export const integrationHandlers: Record<string, Handler> = {
  'linear.status': (_p, ctx) => viaService(() => ({ hasKey: integrations(ctx).linear.hasKey() })),

  // The service's own refusal is `{ ok: false }`; the secrets file failing is TOOL_ERROR.
  'linear.setKey': (p, ctx) => {
    const apiKey = requireApiKey(p.apiKey)
    const ifAbsent = optionalFlag(p.ifAbsent, 'ifAbsent')
    return changing(ctx, 'linear', () => integrations(ctx).linear.setKey(apiKey, { ifAbsent }), stored)
  },

  'linear.clearKey': (_p, ctx) =>
    changing(ctx, 'linear', () => {
      integrations(ctx).linear.clearKey()
      return null
    }),

  'linear.issues': (p, ctx) => {
    const ids = requireIssueIds(p.ids)
    return viaService(() => integrations(ctx).linear.issues(ids))
  },

  // The worktree's path from the server's state, checked as the worktree commands check it.
  'skills.list': (p, ctx) => {
    const { worktree } = present(ctx, p)
    return viaService(() => integrations(ctx).skills.list(worktree.path))
  }
}
