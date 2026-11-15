// `ui.report`: a client says which worktree and session it shows (capability `ui`).
import { MAX_UI_ID } from '../../../src/shared/ui.ts'
import { codedError } from '../errors.ts'
import { requireString } from '../validate.ts'
import type { V2Context } from '../v2.ts'

type Handler = (params: any, ctx: V2Context) => unknown

/** An id, or null for none (absent too). Not checked against the project: a tool resolves it when it reads the report. */
function idOrNull(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string' || value === '' || value.length > MAX_UI_ID) {
    throw codedError('BAD_REQUEST', `${field} must be null or a string of at most ${MAX_UI_ID} characters`)
  }
  return value
}

export const uiHandlers: Record<string, Handler> = {
  'ui.report': (p, ctx): null => {
    const projectId = requireString(p.projectId, 'projectId')
    ctx.projects.require(projectId)
    const worktreeId = idOrNull(p.worktreeId, 'worktreeId')
    const sessionId = idOrNull(p.sessionId, 'sessionId')
    // Absent: a use of the client, as every report was before the field existed.
    if (p.active !== undefined && typeof p.active !== 'boolean') throw codedError('BAD_REQUEST', 'active must be a boolean')
    if (!ctx.selections) throw codedError('BAD_REQUEST', 'this server does not track what its clients show')
    ctx.selections.report(projectId, ctx.subscriber, { worktreeId, sessionId, client: ctx.clientKind ?? 'desktop' }, p.active ?? true)
    return null
  }
}
