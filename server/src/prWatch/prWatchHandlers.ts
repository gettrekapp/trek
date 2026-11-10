// The pull request watch's v2 methods (phase 5c-1): turning a branch's watch on or off, and
// dismissing a worktree's notice. The `prWatch` capability says gh is signed in on the server.
import type { BranchData } from '../../../src/shared/model/types'
import { watchableUrl } from '../../../src/shared/prWatch.ts'
import { codedError } from '../errors.ts'
import { repoIn } from '../projects/model.ts'
import { requireBoolean, requireBranch, requireString } from '../validate.ts'
import type { V2Context } from '../v2.ts'

type Handler = (params: any, ctx: V2Context) => unknown

const NOT_SIGNED_IN = 'gh is not installed or not signed in on the Trek server’s machine (run `gh auth login` there as the server’s user)'

export const prWatchHandlers: Record<string, Handler> = {
  /**
   * On: the branch's linked PR must be a github.com pull URL, and gh signed in. Already on, it
   * stays as it is (its `seen` kept). Off works whatever gh says.
   */
  'branch.setPrWatch': (p, ctx) => {
    const branch = requireBranch(p.branch)
    const watch = requireBoolean(p.watch, 'watch')
    if (watch && !ctx.prWatch?.available()) throw codedError('TOOL_ERROR', NOT_SIGNED_IN)
    const { repoId, changed } = ctx.projects.apply(p.projectId, (d) => {
      const repo = repoIn(d, p.repoId)
      const data: BranchData = { ...(Object.hasOwn(repo.branchData, branch) ? repo.branchData[branch] : {}) }
      const changed = watch !== (data.prWatch !== undefined)
      if (watch) {
        if (!data.pr) throw codedError('BAD_REQUEST', `${branch} has no linked pull request`)
        if (!watchableUrl(data.pr)) throw codedError('BAD_REQUEST', `${data.pr} is not a GitHub pull request URL (https://github.com/<owner>/<repo>/pull/<number>)`)
        data.prWatch ??= {}
      } else delete data.prWatch
      if (Object.keys(data).length === 0) delete repo.branchData[branch]
      else repo.branchData[branch] = data
      return { repoId: repo.id, changed }
    })
    if (watch && changed) ctx.prWatch?.pollSoon(requireString(p.projectId, 'projectId'), repoId, branch)
    return null
  },

  'prWatch.dismiss': (p, ctx) => {
    const worktreeId = requireString(p.worktreeId, 'worktreeId')
    const project = ctx.projects.require(p.projectId)
    if (!project.repositories.some((r) => r.worktrees.some((w) => w.id === worktreeId))) {
      throw codedError('NOT_FOUND', `No worktree with id "${worktreeId}" in this project`)
    }
    if (!ctx.prWatch) return null
    ctx.prWatch.dismiss(project.id, worktreeId)
    return null
  }
}
