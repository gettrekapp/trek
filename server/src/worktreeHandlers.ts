// v2 worktree commands. Each one that changes git refreshes the repo through
// the poller before answering, so the client's next patch already shows it.
// worktree.load / worktree.unload start and stop sessions and arrive in 2d.
import { existsSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import * as gitService from '../../src/host/gitService.ts'
import type { Project, Repository, Worktree } from '../../src/shared/model/types'
import { codedError } from './errors.ts'
import { assertNotRepository, findRegistered, repoIn } from './projects/model.ts'
import { realOrResolved as real } from './repos.ts'
import { requireAbsolutePath, requireBoolean, requireBranch, requireString } from './validate.ts'
import type { V2Context } from './v2.ts'
import { checkPath, checkSource } from './review/draft.ts'
import { MAX_REVIEW_COMMENTS } from '../../src/shared/review.ts'
import { assertNotPromoting } from './promote/changing.ts'
import { BY_TREK, recordHistory, tagValue } from './history/record.ts'
import type { HistoryValue } from '../../src/shared/model/history.ts'
import { isInside } from '../../src/host/pathContainment.ts'
import { prOwner, safeParse } from '../../src/shared/plugins/pullRequests.ts'
import { holdWorktree, optionalTeardown, planTeardown, requireOp, runTeardown } from './teardown/teardown.ts'
import { inactiveParticipants, participantsFor } from './teardown/participants.ts'

type Handler = (params: any, ctx: V2Context) => unknown

const bad = (message: string): Error => codedError('BAD_REQUEST', message)

/**
 * A directory name Windows accepts: its forbidden characters (<>:"|?* and control characters)
 * become -, trailing dots and spaces go, and a reserved device name (CON, NUL, COM1…, with any
 * extension) gets a - after it. Elsewhere the name is kept as is. The branch is never renamed.
 */
export function safeDirName(name: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== 'win32') return name
  let out = name.replace(/[<>:"|?*\x00-\x1f]/g, '-').replace(/[. ]+$/, '')
  if (out === '') out = '-'
  if (/^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i.test(out)) out = out.replace(/^([^.]+)/, '$1-')
  return out
}

/** Where a branch's worktree goes by default: next to the repo, as <repo>-<branch>. */
export function defaultWorktreePath(repoPath: string, branch: string, platform: NodeJS.Platform = process.platform): string {
  return join(dirname(repoPath), safeDirName(`${basename(repoPath)}-${branch.replace(/[/\\]/g, '-')}`, platform))
}

/** Runs a git operation; any failure reaches the client as GIT_ERROR with git's message. */
async function viaGit<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation()
  } catch (err) {
    throw codedError('GIT_ERROR', (err as Error).message)
  }
}

/**
 * `git worktree remove` without --force. A refusal because of modified or untracked
 * files is told apart by reading the worktree's status, not git's localised message.
 */
async function removeUnforced(repoPath: string, worktreePath: string, linkedDirs: readonly unknown[]): Promise<void> {
  try {
    await gitService.removeWorktree(repoPath, worktreePath, linkedDirs)
  } catch (err) {
    throw codedError('GIT_ERROR', (err as Error).message, (await hasChanges(worktreePath)) ? { reason: 'dirty' } : undefined)
  }
}

/** Whether `git status --porcelain` lists anything; false when the status cannot be read, so no reason is claimed. */
async function hasChanges(worktreePath: string): Promise<boolean> {
  try {
    const out = await gitService.git(worktreePath, ['--no-optional-locks', 'status', '--porcelain'])
    return out.trim().length > 0
  } catch {
    return false
  }
}

/**
 * Whether the worktree has changes, for a check that must not guess: a status git can't read is
 * GIT_ERROR, never "clean" (hasChanges, for its other callers, fails open).
 */
async function changesOrRefuse(worktreePath: string, refusal: string): Promise<boolean> {
  try {
    const out = await gitService.git(worktreePath, ['--no-optional-locks', 'status', '--porcelain'])
    return out.trim().length > 0
  } catch (err) {
    throw codedError('GIT_ERROR', `couldn't read the status of ${worktreePath}: ${(err as Error).message.trim()}; ${refusal}`)
  }
}

/** IN_USE while any project has the worktree's path loaded (its sessions run there). */
function assertNotLoaded(ctx: V2Context, worktreePath: string): void {
  const key = real(worktreePath)
  const running = [...ctx.projects.all()]
    .filter((project) => project.repositories.some((r) => r.worktrees.some((w) => w.loaded && real(w.path) === key)))
    .map((project) => project.name)
  if (running.length > 0) throw codedError('IN_USE', `${worktreePath} has running sessions in ${running.join(', ')}; unload it first`)
}

/**
 * A worktree may be removed where the allowlist covers it, or wherever git itself
 * lists it as a linked worktree of the repo: an agent's worktree in a temp or
 * scratchpad folder is outside the roots, but its path comes from git, not the
 * client. A row git does not list (a hand-edited file) still needs the allowlist.
 */
async function assertRemovable(ctx: V2Context, repoPath: string, worktreePath: string): Promise<void> {
  try {
    ctx.store.guard.check(worktreePath)
    return
  } catch (err) {
    const key = real(worktreePath)
    const listed = await gitService.listWorktrees(repoPath).catch(() => null)
    if (listed?.some((w) => !w.isMain && real(w.path) === key)) return
    throw err
  }
}

/** Only a real branch name: not a revision expression like @{-1}, nor HEAD, a tag or a SHA. */
export async function checkBranchName(repoPath: string, branch: string, mustExist: boolean): Promise<void> {
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
export function locate(project: Project, worktreeId: unknown): { repo: Repository; worktree: Worktree } {
  const id = requireString(worktreeId, 'worktreeId')
  for (const repo of project.repositories) {
    const worktree = repo.worktrees.find((w) => w.id === id)
    if (worktree) return { repo, worktree }
  }
  throw codedError('NOT_FOUND', `No worktree with id "${id}" in this project`)
}

/**
 * A worktree git still has, in a repository the registry still has, at a path
 * the allowlist covers (a row from a hand-edited file or a not-yet-polled
 * import may not be). The main worktree is its repository's own checkout;
 * any other row must not be, nor contain, a registered repository.
 */
export function present(ctx: V2Context, p: any): { repo: Repository; worktree: Worktree } {
  const found = locate(ctx.projects.require(p.projectId), p.worktreeId)
  findRegistered(ctx.store.config.repos, found.repo.path)
  if (found.worktree.missing) {
    throw bad(`${found.worktree.path} no longer exists; remove the worktree or create its branch again`)
  }
  ctx.store.guard.check(found.worktree.path)
  if (!found.worktree.isMain) assertNotRepository(ctx.store.config.repos, real(found.worktree.path), 'worktree')
  else if (real(found.worktree.path) !== real(found.repo.path)) throw bad(`${found.worktree.path} is not the checkout of ${found.repo.path}`)
  return found
}

/**
 * The worktree and the branch git has checked out in it now: the row can lag a
 * `git checkout` by a poll, so the repo is re-read first. The branch must be a
 * real branch name, since it goes on a git command line.
 */
export async function checkedOut(ctx: V2Context, p: any): Promise<{ repo: Repository; worktree: Worktree; branch: string }> {
  const { repo } = present(ctx, p)
  if (!(await ctx.poller.refresh(repo.path))) {
    throw codedError('GIT_ERROR', `could not re-read the worktrees: ${ctx.poller.warning(repo.path)?.message ?? 'unknown error'}`)
  }
  const { worktree } = present(ctx, p)
  if (!worktree.branch) throw bad(`${worktree.path} has no branch checked out (detached HEAD)`)
  await checkBranchName(repo.path, worktree.branch, false)
  return { repo, worktree, branch: worktree.branch }
}

/** `worktree.diff`'s optional `paths` (5c-2): at most MAX_REVIEW_COMMENTS file paths, as a comment names them. */
function checkDiffPaths(value: unknown): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) throw codedError('BAD_REQUEST', 'paths must be an array of file paths')
  if (value.length > MAX_REVIEW_COMMENTS) throw codedError('BAD_REQUEST', `paths must hold at most ${MAX_REVIEW_COMMENTS} entries`)
  return value.map((v, i) => checkPath(v, `paths[${i}]`))
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
    const project = ctx.projects.require(p.projectId)
    const repo = repoIn(project, p.repoId)
    let prRef: string | undefined
    if (fromPr !== undefined) {
      // The ref to fetch is the PR's provider's: prUrl's owner, else the project's only one.
      const providers = ctx.plugins?.prProviders(project.id) ?? []
      const prUrl = p.prUrl === undefined ? undefined : requireString(p.prUrl, 'prUrl')
      const provider = prUrl !== undefined ? prOwner(providers, prUrl) : providers.length === 1 ? providers[0] : undefined
      if (!provider) {
        throw bad(prUrl !== undefined ? `no pull request provider is on for ${prUrl} in this project` : 'no single pull request provider is on in this project: pass prUrl')
      }
      if (prUrl !== undefined) {
        const parsed = safeParse(provider, prUrl)
        if (parsed?.number !== fromPr) throw bad(`prUrl is ${parsed ? `pull request ${parsed.label}` : 'not a pull request link its provider reads'}, not #${fromPr}`)
      }
      try {
        prRef = provider.fetchRef(fromPr)
        gitService.assertPullRequestRef(prRef)
      } catch (err) {
        throw codedError('TOOL_ERROR', `pull request provider ${provider.id} gave no usable ref for #${fromPr}: ${(err as Error).message}`)
      }
    }
    findRegistered(ctx.store.config.repos, repo.path)
    const requested = p.path === undefined ? defaultWorktreePath(repo.path, branch) : requireAbsolutePath(p.path, 'path')
    const target = ctx.store.guard.check(requested)
    assertNotRepository(ctx.store.config.repos, target, 'path', requested)
    if (existsSync(target)) throw bad(`${requested} already exists`)
    const inside = (root: string): boolean => isInside(real(root), target, process.platform, true)
    if (ctx.store.config.repos.some((r) => inside(r.path)) || repo.worktrees.some((w) => !w.missing && inside(w.path))) {
      throw bad(`${requested} is inside an existing checkout`)
    }
    await checkBranchName(repo.path, branch, !createBranch && fromPr === undefined)

    if (prRef !== undefined && fromPr !== undefined) {
      const ref = prRef
      // A failed look (not "no such branch") is GIT_ERROR: guessing "absent" would skip the guard
      // below and let the cleanup delete a branch this call didn't make.
      const existed = (await viaGit(() => gitService.localBranchSha(repo.path, branch))) !== null
      // A local branch of that name that is not the PR's (a fork PR's head is often main) is never
      // fetched into or checked out for it. pr/<n> is Trek's own name for the PR. Known limit: it is
      // trusted by name, so with two PR providers on, a pr/<n> left from the other provider's PR #n
      // is fast-forwarded (or, diverged, checked out) as this one's.
      if (existed && branch !== `pr/${fromPr}` && !(await viaGit(() => gitService.isPullRequestBranch(repo.path, ref, branch)))) {
        throw bad(`a local branch named "${branch}" already exists and is not pull request #${fromPr}'s head; check the PR out as pr/${fromPr}`)
      }
      await viaGit(async () => {
        try {
          await gitService.fetchPullRequestHead(repo.path, ref, branch)
        } catch (err) {
          // The PR's own local branch that cannot fast-forward to its head can still be
          // checked out; the user reconciles it in the worktree.
          if (!existed) throw err
        }
        try {
          await gitService.addWorktreeAt(repo.path, target, branch)
        } catch (err) {
          // The branch this call fetched goes with the worktree git refused.
          if (!existed) await gitService.git(repo.path, ['branch', '-D', '--', branch]).catch(() => {})
          throw err
        }
      })
    } else {
      await viaGit(() => gitService.addWorktree(repo.path, target, branch, createBranch))
    }
    const linkWarnings = await gitService.linkDirs(repo.path, target, repo.linkedDirs ?? [])
    const listed = await ctx.poller.refresh(repo.path)
    if (!listed) {
      throw codedError('GIT_ERROR', `created ${target} but could not re-read the worktrees: ${ctx.poller.warning(repo.path)?.message ?? 'unknown error'}`)
    }

    const { worktreeId, branchName, tagged } = ctx.projects.apply(p.projectId, (d) => {
      const r = repoIn(d, repo.id)
      const created = r.worktrees.find((w) => !w.isMain && real(w.path) === target)
      if (!created) throw codedError('GIT_ERROR', `git created ${target} but does not list it`)
      const firstTag = d.settings.worktreeTags?.[0]?.id
      const data = Object.hasOwn(r.branchData, branch) ? r.branchData[branch] : undefined
      let tagged: HistoryValue | undefined
      // Only when git really checked the branch out (a same-named tag would leave HEAD detached).
      if (firstTag && !data?.tag && created.branch === branch) {
        r.branchData[branch] = { ...data, tag: firstTag }
        tagged = tagValue(d.settings.worktreeTags, firstTag)
      }
      return { worktreeId: created.id, branchName: created.branch, tagged }
    })
    const projectId = requireString(p.projectId, 'projectId')
    recordHistory(ctx, projectId, repo.id, branchName, [{ kind: 'created', to: { text: target } }])
    if (tagged) recordHistory(ctx, projectId, repo.id, branchName, [{ kind: 'status', to: tagged }], BY_TREK)
    return linkWarnings.length > 0 ? { worktreeId, linkWarnings } : { worktreeId }
  },

  /** What would be torn down before the worktree is removed, promoted or moved (plugins E1): every participant's items, ids namespaced. */
  'worktree.teardownPlan': async (p, ctx) => {
    const op = requireOp(p.op)
    const project = ctx.projects.require(p.projectId)
    const { repo, worktree } = locate(project, p.worktreeId)
    if (worktree.isMain) throw bad('the main checkout is never removed, promoted or moved, so it has no teardown')
    return { items: await planTeardown(participantsFor(ctx, project.id), { project, repo, worktree }, op) }
  },

  'worktree.remove': async (p, ctx) => {
    const force = p.force === undefined ? false : requireBoolean(p.force, 'force')
    const teardown = optionalTeardown(p.teardown)
    const project = ctx.projects.require(p.projectId)
    const { repo, worktree } = locate(project, p.worktreeId)
    if (worktree.isMain) throw bad('the main worktree cannot be removed')
    assertNotPromoting(repo.path)
    assertNotLoaded(ctx, worktree.path)

    if (!worktree.missing) {
      findRegistered(ctx.store.config.repos, repo.path)
      await assertRemovable(ctx, repo.path, worktree.path)
      // Another registered repo's checkout may be listed as a row here.
      assertNotRepository(ctx.store.config.repos, real(worktree.path), 'worktree')
    }
    // The chosen teardown (plugins E1), after every check: a removal git would refuse for changes
    // tears nothing down (the client asks, then forces with the same ids).
    if (teardown.length > 0 && !force && !worktree.missing && (await changesOrRefuse(worktree.path, 'nothing was torn down'))) {
      throw codedError('GIT_ERROR', `${worktree.path} has modified or untracked files; nothing was torn down`, { reason: 'dirty' })
    }

    // Held for the teardown and the removal: a worktree being torn down (by this or another
    // operation) is CONFLICT, with or without `teardown`. From before the teardown until the
    // re-read has marked the row missing, no session or load may start in it.
    await holdWorktree(worktree.path, async (hold) => {
      const unblock = ctx.sessions.blockPath(worktree.path)
      try {
        // Again under the block: a load that landed after the first check would have its sessions
        // in a worktree being torn down. None can land from here on.
        assertNotLoaded(ctx, worktree.path)
        await runTeardown(participantsFor(ctx, project.id), { project, repo, worktree }, 'remove', teardown, { hold, inactive: inactiveParticipants(ctx, project.id) })
        // A directory that is already gone is removed from git's list too, and
        // only this one: a repo-wide prune would drop worktrees on unmounted volumes.
        if (!worktree.missing) {
          if (force) await viaGit(() => gitService.removeWorktreeForce(repo.path, worktree.path, repo.linkedDirs ?? []))
          else await removeUnforced(repo.path, worktree.path, repo.linkedDirs ?? [])
          // Git has removed it. Even if the re-read fails, the row goes below.
          await ctx.poller.refresh(repo.path)
        }
      } finally {
        unblock()
      }
    })

    // The poller keeps a vanished row that has sessions (as missing); an explicit remove drops it.
    ctx.projects.apply(p.projectId, (d) => {
      const r = d.repositories.find((x) => x.id === repo.id)
      if (!r) return
      r.worktrees = r.worktrees.filter((w) => w.id !== worktree.id)
      const orderKey = `${repo.id} ${worktree.path}`
      if (d.settings.worktreeOrder) {
        const order = d.settings.worktreeOrder.filter((k) => k !== orderKey)
        if (order.length > 0) d.settings.worktreeOrder = order
        else delete d.settings.worktreeOrder
      }
    })
    // The `attention` topic lists the row's PR notice (5c-1), if it had one.
    ctx.sessions.refreshAttention()
    recordHistory(ctx, requireString(p.projectId, 'projectId'), repo.id, worktree.branch, [{ kind: 'removed', from: { text: worktree.path } }])
    return null
  },

  'worktree.pull': async (p, ctx) => {
    const { repo, worktree, branch } = await checkedOut(ctx, p)
    assertNotPromoting(repo.path)
    await viaGit(() => gitService.pull(worktree.path, branch))
    await ctx.poller.refresh(repo.path, { status: true })
    return null
  },

  'worktree.push': async (p, ctx) => {
    const setUpstream = requireBoolean(p.setUpstream, 'setUpstream')
    const { repo, worktree, branch } = await checkedOut(ctx, p)
    await viaGit(() => gitService.push(worktree.path, branch, setUpstream))
    await ctx.poller.refresh(repo.path, { status: true })
    return null
  },

  // `source` (5c-2): the branch against its base (the default), the uncommitted work, or one commit.
  'worktree.changes': async (p, ctx) => {
    const source = checkSource(p.source)
    const { worktree } = present(ctx, p)
    return viaGit(() => gitService.worktreeChanges(worktree.path, source))
  },

  'worktree.diff': async (p, ctx) => {
    const source = checkSource(p.source)
    const paths = checkDiffPaths(p.paths)
    const { worktree } = present(ctx, p)
    return viaGit(() => gitService.worktreeDiff(worktree.path, source, paths))
  },

  /** The newest commits on its HEAD, for the Changes tab's commit picker (5c-2) */
  'worktree.commits': async (p, ctx) => {
    const { worktree } = present(ctx, p)
    return viaGit(() => gitService.worktreeCommits(worktree.path))
  },

  // A delete's fresh check before it destroys a worktree's dev stack or VM (the poll's `dirty` can be 30 s old).
  'worktree.dirty': async (p, ctx) => {
    const { worktree } = present(ctx, p)
    return gitService.worktreeDirty(worktree.path)
  }
}
