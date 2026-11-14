// `history.list` (PROTOCOL.md, "Worktree history"): a branch's history, newest first, a page at a time.
import { HISTORY_PAGE_SIZE } from '../../../src/shared/model/history.ts'
import { codedError } from '../errors.ts'
import { repoIn } from '../projects/model.ts'
import { requireBranch } from '../validate.ts'
import type { V2Context } from '../v2.ts'

type Handler = (params: any, ctx: V2Context) => unknown

const bad = (message: string): Error => codedError('BAD_REQUEST', message)

export const historyHandlers: Record<string, Handler> = {
  'history.list': (p, ctx) => {
    const project = ctx.projects.require(p.projectId)
    const repo = repoIn(project, p.repoId)
    const branch = requireBranch(p.branch)
    if (p.before !== undefined && typeof p.before !== 'string') throw bad('before must be an event id')
    let limit = HISTORY_PAGE_SIZE
    if (p.limit !== undefined) {
      if (!Number.isInteger(p.limit) || p.limit < 1 || p.limit > HISTORY_PAGE_SIZE) throw bad(`limit must be an integer from 1 to ${HISTORY_PAGE_SIZE}`)
      limit = p.limit
    }
    if (!ctx.history) return { events: [], more: false }
    return ctx.history.list(project.id, repo.id, branch, { before: p.before, limit })
  }
}
