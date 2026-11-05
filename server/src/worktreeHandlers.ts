// v2 worktree commands. Each one that changes git refreshes the repo through
// the poller before answering, so the client's next patch already shows it.
// worktree.load / worktree.unload start and stop sessions and arrive in 2d.
import { existsSync } from 'node:fs'
import { basename, dirname, join, sep } from 'node:path'
import * as gitService from '../../src/host/gitService.ts'
import type { Project, Repository, Worktree } from '../../src/shared/model/types'
import { codedError } from './errors.ts'
import { assertNotRepository, findRegistered, repoIn } from './projects/model.ts'
import { realOrResolved as real } from './repos.ts'
import { requireAbsolutePath, requireBoolean, requireBranch, requireString } from './validate.ts'
import type { V2Context } from './v2.ts'

type Handler = (params: any, ctx: V2Context) => unknown

const bad = (message: string): Error => codedError('BAD_REQUEST', message)

/** Where a branch's worktree goes by default: next to the repo, as <repo>-<branch>. */
export function defaultWorktreePath(repoPath: string, branch: string): string {
  return join(dirname(repoPath), `${basename(repoPath)}-${branch.replace(/[/\\]/g, '-')}`)
}

/** Runs a git operation; any failure reaches the client as GIT_ERROR with git's message. */
async function viaGit<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation()
  } catch (err) {
    throw codedError('GIT_ERROR', (err as Error).message)
  }
}

/** Only a real branch name: not a revision expression like @{-1}, nor HEAD, a tag or a SHA. */
async function checkBranchName(repoPath: string, branch: string, mustExist: boolean): Promise<void> {
  if (branch.startsWith('-')) throw bad('branch must not start with "-"')
  if (branch === '@' || branch === 'HEAD') throw bad(`"${branch}" is not a valid branch name`)
  try {
    await gitService.git(repoPath, ['check-ref-format', '--branch', branch])
    await gitService.git(repoPath, ['check-ref-format', `refs/heads/${branch}`])
  } catch {
    throw bad(`"${branch}" is not a valid branch name`)
  }
  if (!mustExist) return
  const exists = await gitService.git(repoPath, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).then(() => true, () => false)
  if (exists) return
  // git creates a tracking branch from a remote branch of the same name.
  const remotes = await viaGit(() => gitService.git(repoPath, ['for-each-ref', '--format=%(refname)', 'refs/remotes']))
  const tracked = remotes.split('\n').some((ref) => {
    const rest = ref.startsWith('refs/remotes/') ? ref.slice('refs/remotes/'.length) : ''
    return rest.slice(rest.indexOf('/') + 1) === branch && rest.includes('/')
  })
  if (!tracked) throw codedError('GIT_ERROR', `no branch named "${branch}"`)
}

/** The worktree with this id and its repository; NOT_FOUND if unknown. */
function locate(project: Project, worktreeId: unknown): { repo: Repository; worktree: Worktree } {
  const id = requireString(worktreeId, 'worktreeId')
  for (const repo of project.repositories) {
    const worktree = repo.worktrees.find((w) => w.id === id)
    if (worktree) return { repo, worktree }
  }
  throw codedError('NOT_FOUND', `No worktree with id "${id}" in this project`)
}

/** A worktree git still has, in a repository the registry still has. */
function present(ctx: V2Context, p: any): { repo: Repository; worktree: Worktree } {
  const found = locate(ctx.projects.require(p.projectId), p.worktreeId)
  findRegistered(ctx.store.config.repos, found.repo.path)
  if (found.worktree.missing) {
    throw bad(`${found.worktree.path} no longer exists; remove the worktree or create its branch again`)
  }
  return found
}

function checkedOutBranch(worktree: Worktree): string {
  if (!worktree.branch) throw bad(`${worktree.path} has no branch checked out (detached HEAD)`)
  return worktree.branch
}

export const worktreeHandlers: Record<string, Handler> = {
  'worktree.create': async (p, ctx) => {
    const branch = requireBranch(p.branch)
    const createBranch = requireBoolean(p.createBranch, 'createBranch')
    let fromPr: number | undefined
    if (p.fromPr !== undefined) {
      if (!Number.isInteger(p.fromPr) || p.fromPr < 1) throw bad('fromPr must be a positive integer')
      if (createBranch) throw bad('fromPr checks out the PR head into an existing or fetched branch; createBranch must be false')
      fromPr = p.fromPr
    }
    const repo = repoIn(ctx.projects.require(p.projectId), p.repoId)
    findRegistered(ctx.store.config.repos, repo.path)
    const requested = p.path === undefined ? defaultWorktreePath(repo.path, branch) : requireAbsolutePath(p.path, 'path')
    const target = ctx.store.guard.check(requested)
    assertNotRepository(ctx.store.config.repos, target, 'path', requested)
    if (existsSync(target)) throw bad(`${requested} already exists`)
    const inside = (root: string): boolean => target.startsWith(real(root) + sep)
    if (ctx.store.config.repos.some((r) => inside(r.path)) || repo.worktrees.some((w) => !w.missing && inside(w.path))) {
      throw bad(`${requested} is inside an existing checkout`)
    }
    await checkBranchName(repo.path, branch, !createBranch && fromPr === undefined)

    await viaGit(async () => {
      if (fromPr === undefined) {
        await gitService.addWorktree(repo.path, target, branch, createBranch)
        return
      }
      try {
        await gitService.fetchPullRequestHead(repo.path, fromPr, branch)
      } catch (err) {
        // A local branch that cannot fast-forward to the PR head can still be
        // checked out; the user reconciles it in the worktree.
        if (!(await gitService.listBranches(repo.path)).includes(branch)) throw err
      }
      await gitService.addWorktreeAt(repo.path, target, branch)
    })
    await gitService.linkDirs(repo.path, target, repo.linkedDirs ?? [])
    const listed = await ctx.poller.refresh(repo.path)
    if (!listed) {
      throw codedError('GIT_ERROR', `created ${target} but could not re-read the worktrees: ${ctx.poller.warning(repo.path)?.message ?? 'unknown error'}`)
    }

    const worktreeId = ctx.projects.apply(p.projectId, (d) => {
      const r = repoIn(d, repo.id)
      const created = r.worktrees.find((w) => !w.isMain && real(w.path) === target)
      if (!created) throw codedError('GIT_ERROR', `git created ${target} but does not list it`)
      const firstTag = d.settings.worktreeTags?.[0]?.id
      const data = Object.hasOwn(r.branchData, branch) ? r.branchData[branch] : undefined
      // Only when git really checked the branch out (a same-named tag would leave HEAD detached).
      if (firstTag && !data?.tag && created.branch === branch) r.branchData[branch] = { ...data, tag: firstTag }
      return created.id
    })
    return { worktreeId }
  }
}
