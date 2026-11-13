// The skills on the server's disk (phase 5b; capability `skills`). (Linear and ElevenLabs, with
// the server's own keys, are plugins since plugin system phases 1 and 2: plugins/linear,
// plugins/voice.)
import type { V2Context } from '../v2.ts'
import { present } from '../worktreeHandlers.ts'
import { codedError } from '../errors.ts'
import type { Integrations } from './integrations.ts'

type Handler = (params: any, ctx: V2Context) => unknown

export const integrations = (ctx: V2Context): Integrations => {
  if (!ctx.integrations) throw codedError('NOT_FOUND', 'this server has no integrations')
  return ctx.integrations
}

/**
 * Any failure (the skills unreadable) is TOOL_ERROR with its message, never INTERNAL; only
 * BAD_REQUEST and NOT_FOUND (no integrations, a worktree that is not there) pass through as they are.
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

export const integrationHandlers: Record<string, Handler> = {
  // The worktree's path from the server's state, checked as the worktree commands check it.
  'skills.list': (p, ctx) => {
    const { worktree } = present(ctx, p)
    return viaService(() => integrations(ctx).skills.list(worktree.path))
  }
}
