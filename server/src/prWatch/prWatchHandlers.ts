// The pull request watch's v2 methods (phase 5c-1): turning a branch's watch on or off, and
// dismissing a worktree's notice. The `prWatch` capability says some PR provider is signed in on the
// server; turning a watch on needs the one that owns the branch's link (plugins P3).
import type { BranchData } from '../../../src/shared/model/types'
import { prOwner, safeParse } from '../../../src/shared/plugins/pullRequests.ts'
import { recordHistory } from '../history/record.ts'
import { codedError } from '../errors.ts'
import { repoIn } from '../projects/model.ts'
import { requireBoolean, requireBranch, requireString } from '../validate.ts'
import type { V2Context } from '../v2.ts'

type Handler = (params: any, ctx: V2Context) => unknown

/** A provider's sign-in is missing; how to sign in is the plugin's to say (its README) */
export const notSignedIn = (signInName: string): string =>
  `${signInName} is not installed or not signed in on the Trek server’s machine (sign it in there as the server’s user)`

export const prWatchHandlers: Record<string, Handler> = {
  /**
   * On: the branch's linked PR must be owned by a PR provider on for the project, and that
   * provider signed in. Already on, it stays as it is (its `seen` kept). Off works whatever the
   * provider says.
   */
  'branch.setPrWatch': (p, ctx) => {
    const branch = requireBranch(p.branch)
    const watch = requireBoolean(p.watch, 'watch')
    const { repoId, changed } = ctx.projects.apply(p.projectId, (d) => {
      const repo = repoIn(d, p.repoId)
      const data: BranchData = { ...(Object.hasOwn(repo.branchData, branch) ? repo.branchData[branch] : {}) }
      const changed = watch !== (data.prWatch !== undefined)
      if (watch) {
        if (!data.pr) throw codedError('BAD_REQUEST', `${branch} has no linked pull request`)
        const owner = prOwner(ctx.plugins?.prProviders(d.id) ?? [], data.pr)
        // Exactly what the watch will poll (watchTargets): an owner whose parse gives the stored link back.
        if (!owner || safeParse(owner, data.pr)?.url !== data.pr) {
          throw codedError('BAD_REQUEST', `no pull request provider is on for ${data.pr} in this project (Settings → Plugins)`)
        }
        if (!ctx.prWatch?.availableFor(owner.id)) throw codedError('TOOL_ERROR', notSignedIn(owner.signInName))
        data.prWatch ??= {}
      } else delete data.prWatch
      if (Object.keys(data).length === 0) delete repo.branchData[branch]
      else repo.branchData[branch] = data
      return { repoId: repo.id, changed }
    })
    const projectId = requireString(p.projectId, 'projectId')
    if (changed) recordHistory(ctx, projectId, repoId, branch, [{ kind: watch ? 'prWatch.on' : 'prWatch.off' }])
    if (watch && changed) ctx.prWatch?.pollSoon(projectId, repoId, branch)
    // Off: its failures are forgotten, so turned on again it can raise a fresh "can't be read" notice.
    if (!watch) ctx.prWatch?.forget(projectId, repoId, branch)
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
