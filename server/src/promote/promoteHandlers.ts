// Promote to primary and its reverse (phase 5e), behind the `promote` capability. One server, so
// each is one request that does everything or puts everything back:
//
// - `worktree.promote`: a worktree's branch is switched to in the repository's main checkout
//   (which must be clean) while the worktree still has it (`--ignore-other-worktrees`), the
//   worktree's uncommitted work (5d's config-proof patch) is applied there and checked by digest,
//   and only then is the worktree removed (the point of commitment). Its sessions that can follow
//   (sessionMigrates: Claude and Local) move to the main checkout with their histories and resume
//   there; the main checkout's own sessions keep running, on the new branch.
// - `worktree.demote` ("Promote branch to worktree"): the main checkout's branch gets a new
//   worktree at the default path (`worktree add --force`, while the main checkout still has it),
//   the main checkout's uncommitted work is applied there and checked, taken off the main checkout
//   (`apply -R`, its index reset), and the main checkout switches back to the default branch (the
//   point of commitment). Its sessions that can follow move to the new worktree; the others stay.
//
// `dryRun: true` answers the plan the confirmation shows, after the same checks.
import { copyFile, mkdtemp, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import * as gitService from '../../../src/host/gitService.ts'
import { migrateSession } from '../../../src/host/claudeSessionService.ts'
import type { Project, Repository, Session, Worktree } from '../../../src/shared/model/types'
import { sessionMigrates } from '../../../src/shared/providers/selection.ts'
import { getProvider } from '../../../src/shared/providers/registry.ts'
import {
  MAX_PROMOTE_LISTED_PATHS,
  MAX_PROMOTE_PATCH_BYTES,
  type PromoteOutcome,
  type PromotePlan,
  type PromoteResult,
  type PromoteSessionInfo
} from '../../../src/shared/promote.ts'
import { codedError } from '../errors.ts'
import { assertNotRepository, findRegistered, repoIn } from '../projects/model.ts'
import { realOrResolved as real } from '../repos.ts'
import { requireString } from '../validate.ts'
import type { V2Context } from '../v2.ts'
import { checkBranchName, checkedOut, defaultWorktreePath, present } from '../worktreeHandlers.ts'

type Handler = (params: any, ctx: V2Context) => unknown

const bad = (message: string): Error => codedError('BAD_REQUEST', message)

/** Repositories (real path) a promote or demote is changing right now: one at a time per repository. */
const changing = new Set<string>()
/** For the tests */
export const promoteChanging: Set<string> = changing

async function viaGit<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation()
  } catch (err) {
    if (err instanceof gitService.NotUtf8PatchError || err instanceof gitService.PatchTooBigError || err instanceof gitService.NestedRepoError) {
      throw bad(err.message)
    }
    throw codedError('GIT_ERROR', (err as Error).message)
  }
}

function optionalDryRun(value: unknown): boolean {
  if (value === undefined) return false
  if (typeof value !== 'boolean') throw bad('dryRun must be a boolean')
  return value
}

/** The repository's main checkout row, present, the registered repository's own checkout. */
function mainOf(ctx: V2Context, projectId: string, repo: Repository): Worktree {
  const main = repo.worktrees.find((w) => w.isMain)
  if (!main) throw codedError('NOT_FOUND', `${repo.path} has no main checkout listed yet`)
  return present(ctx, { projectId, worktreeId: main.id }).worktree
}

/** Fresh uncommitted-work check; refuses when git can't say. */
async function isDirty(path: string): Promise<boolean> {
  const dirty = await gitService.worktreeDirty(path)
  if (dirty === null) throw codedError('GIT_ERROR', `could not read the status of ${path}`)
  return dirty
}

/** The sessions that follow (sessionMigrates) and what the plan says of each. */
function splitSessions(sessions: readonly Session[], stays: string): { info: PromoteSessionInfo[]; moving: Session[] } {
  const info: PromoteSessionInfo[] = []
  const moving: Session[] = []
  for (const s of sessions) {
    const base = { title: s.title, provider: s.llm.provider }
    if (sessionMigrates(s)) {
      moving.push(s)
      info.push({ ...base, carried: true })
    } else {
      info.push({ ...base, carried: false, reason: `${getProvider(s.llm.provider).label} keeps its history by folder, so it can't follow; ${stays}` })
    }
  }
  return { info, moving }
}

/** The patch of a checkout's uncommitted work (5d's), `linked` paths left out when given. */
function patchOf(path: string, repo: Repository, linked?: readonly string[]): Promise<{ patch: string; headSha: string }> {
  return viaGit(() =>
    gitService.exportDirtyPatch(path, repo.linkedDirs ?? [], { maxBytes: MAX_PROMOTE_PATCH_BYTES, repoPath: repo.path, ...(linked ? { linked } : {}) })
  )
}

/** git apply's refusal of a file under one of the new worktree's linked folders, said plainly. */
function linkedApplyMessage(stderr: string, repo: Repository): string | null {
  const m = /affected file '([^']+)' is beyond a symbolic link/.exec(stderr)
  if (!m) return null
  return `the uncommitted work has ${m[1]}, inside a folder the new worktree links from ${repo.path} (the repository's linked folders); nothing was changed. Commit or move it first`
}

/** Moves the sessions' histories between the checkouts' Claude folders; what could not move. */
async function moveHistories(sessions: readonly Session[], from: string, to: string): Promise<string[]> {
  const notes: string[] = []
  for (const s of sessions) {
    if (!s.agentSessionId) continue
    try {
      await migrateSession(s.agentSessionId, from, to)
    } catch (err) {
      notes.push(`The history of “${s.title}” could not be moved (${(err as Error).message}); it starts afresh`)
    }
  }
  return notes
}

/** The session as it arrives in the other checkout: no pty, no exit, no open question. */
function handedOver(s: Session): Session {
  const out: Session = structuredClone(s)
  delete out.ptyId
  delete out.exitCode
  delete out.decision
  if (out.status !== 'complete') out.status = 'idle'
  return out
}

/** The draft moves to a row that has none: a revision above both rows' last, so none ever repeats. */
function carryReview(from: Worktree, to: Worktree): boolean {
  if (!from.review || from.review.comments.length === 0 || (to.review && to.review.comments.length > 0)) return false
  const revision = Math.max(from.reviewRevision ?? 0, from.review.revision, to.reviewRevision ?? 0) + 1
  to.review = { revision, comments: structuredClone(from.review.comments) }
  to.reviewRevision = revision
  return true
}

function dropOrderKey(d: Project, repoId: string, path: string): void {
  const orderKey = `${repoId} ${path}`
  if (!d.settings.worktreeOrder) return
  const order = d.settings.worktreeOrder.filter((k) => k !== orderKey)
  if (order.length > 0) d.settings.worktreeOrder = order
  else delete d.settings.worktreeOrder
}

/** One promote or demote per repository at a time. */
async function locked<T>(repo: Repository, work: () => Promise<T>): Promise<T> {
  const key = real(repo.path)
  if (changing.has(key)) throw codedError('CONFLICT', `another promote is changing ${repo.path} right now; try again once it is done`)
  changing.add(key)
  try {
    return await work()
  } finally {
    changing.delete(key)
  }
}

/** Runs each undo step, newest first, never throwing (the error the caller shows is the first). */
async function undoAll(undo: (() => Promise<unknown>)[]): Promise<string[]> {
  const failed: string[] = []
  for (const step of undo.reverse()) await step().catch((err: Error) => failed.push(err.message))
  return failed
}

function withUndoNote(err: unknown, failed: string[]): Error {
  if (failed.length === 0) return err as Error
  const e = err as Error & { code?: unknown }
  // Keeps the first error's code (CONFLICT, BAD_REQUEST…): the message says what else went wrong.
  const out = new Error(`${e.message}. Putting things back also failed (${failed.join('; ')}): check the checkouts with git status`) as Error & { code?: unknown }
  out.code = e.code ?? 'GIT_ERROR'
  return out
}

interface PromoteChecked {
  project: Project
  repo: Repository
  worktree: Worktree
  main: Worktree
  branch: string
  mainHead: { branch: string | null; sha: string }
  plan: PromotePlan
  moving: Session[]
}

async function checkPromote(ctx: V2Context, p: any): Promise<PromoteChecked> {
  const { worktree: row } = present(ctx, p)
  if (row.isMain) throw bad('this is already the main checkout')
  const { repo, worktree, branch } = await checkedOut(ctx, p)
  const projectId = requireString(p.projectId, 'projectId')
  const main = mainOf(ctx, projectId, repo)
  const mainHead = await viaGit(() => gitService.headState(main.path))
  if (await isDirty(main.path)) {
    throw codedError('CONFLICT', `the main checkout ${main.path} has uncommitted changes; commit or stash them there first`)
  }
  const dirty = await isDirty(worktree.path)
  const { info, moving } = splitSessions(worktree.sessions, 'it is closed')
  const left = await viaGit(() => gitService.leftBehind(worktree.path, repo.linkedDirs ?? [], MAX_PROMOTE_LISTED_PATHS, repo.path))
  if (left.nestedRepos.length > 0) {
    throw bad(`${left.nestedRepos.join(', ')} ${left.nestedRepos.length === 1 ? 'is a git repository' : 'are git repositories'} of its own inside the worktree, which a promote can't carry; commit it as a submodule, or move it out, first`)
  }
  const reviewComments = worktree.review?.comments.length ?? 0
  const plan: PromotePlan = {
    branch,
    mainPath: main.path,
    worktreePath: worktree.path,
    mainBranch: mainHead.branch,
    dirty,
    loaded: worktree.loaded,
    otherLoaded: main.loaded,
    sessions: info,
    reviewComments,
    reviewCarried: reviewComments > 0 && !(main.review && main.review.comments.length > 0),
    ignored: left.ignored,
    ignoredCount: left.ignoredCount,
    hiddenChanges: left.hiddenChanges,
    hiddenChangesCount: left.hiddenChangesCount
  }
  return { project: ctx.projects.require(projectId), repo, worktree, main, branch, mainHead, plan, moving }
}

async function promote(ctx: V2Context, c: PromoteChecked): Promise<PromoteResult> {
  const { project, repo, worktree, main, branch, mainHead, moving } = c
  const wasLoaded = worktree.loaded
  const undo: (() => Promise<unknown>)[] = []
  const unblockWorktree = ctx.sessions.blockPath(worktree.path)
  const unblockMain = ctx.sessions.blockPath(main.path)
  let failure: Error | undefined
  try {
    // Its agents stop first: none may write to the worktree while its work is carried.
    if (wasLoaded) ctx.sessions.unloadWorktree({ projectId: project.id, worktreeId: worktree.id })
    const { patch } = await patchOf(worktree.path, repo)
    // Pushed before the switch: one that fails part way has written files already. The main
    // checkout was clean, so going back discards nothing of its own.
    undo.push(() => gitService.forceCheckoutHead(main.path, mainHead))
    await viaGit(() => gitService.checkoutIgnoringOtherWorktrees(main.path, branch))
    if (patch !== '') {
      await viaGit(() => gitService.applyPatch(main.path, patch))
      undo.push(() => gitService.reverseApplyPatch(main.path, patch))
    }
    // The work as the main checkout now has it must be the worktree's, exactly (5d's check).
    const applied = await patchOf(main.path, repo)
    if (gitService.patchDigest(applied.patch) !== gitService.patchDigest(patch)) {
      throw codedError('GIT_ERROR', "the uncommitted work in the main checkout does not match the worktree's after the apply; nothing was changed")
    }
    // The point of commitment: the main checkout holds the branch and its work.
    await viaGit(() => gitService.removeWorktreeForce(repo.path, worktree.path))
  } catch (err) {
    failure = withUndoNote(err, await undoAll(undo))
  } finally {
    unblockMain()
    unblockWorktree()
  }
  if (failure) {
    if (wasLoaded) {
      try {
        ctx.sessions.loadWorktree({ projectId: project.id, worktreeId: worktree.id })
      } catch (err) {
        console.error(`could not load ${worktree.path} again after a failed promote`, err)
      }
    }
    await ctx.poller.refresh(repo.path).catch(() => false)
    throw failure
  }

  await ctx.poller.refresh(repo.path).catch(() => false)
  const notes = await moveHistories(moving, worktree.path, main.path)
  for (const s of worktree.sessions) if (!sessionMigrates(s)) notes.push(`“${s.title}” was closed: ${getProvider(s.llm.provider).label} can't follow a worktree to another folder`)
  const movedIds = moving.map((s) => s.id)
  let mainLoaded = false
  ctx.projects.apply(project.id, (d) => {
    const r = repoIn(d, repo.id)
    const from = r.worktrees.find((w) => w.id === worktree.id)
    const to = r.worktrees.find((w) => w.id === main.id)
    if (to && from) {
      to.sessions.push(...from.sessions.filter((s) => movedIds.includes(s.id)).map(handedOver))
      if (from.review && from.review.comments.length > 0 && !carryReview(from, to)) {
        notes.push(`The worktree's review draft (${from.review.comments.length} comments) was dropped: the main checkout has a draft of its own`)
      }
      if (from.prNotice && !to.prNotice) to.prNotice = from.prNotice
      mainLoaded = to.loaded
    }
    r.worktrees = r.worktrees.filter((w) => w.id !== worktree.id)
    dropOrderKey(d, repo.id, worktree.path)
  })
  // The sessions resume where they now are when either checkout was running.
  if (movedIds.length > 0 && (wasLoaded || mainLoaded)) {
    try {
      if (mainLoaded) ctx.sessions.resumeSessions(project.id, movedIds)
      else ctx.sessions.loadWorktree({ projectId: project.id, worktreeId: main.id })
    } catch (err) {
      notes.push(`The sessions moved but could not be resumed: ${(err as Error).message}`)
    }
  }
  ctx.sessions.refreshAttention()
  return { worktreeId: main.id, moved: movedIds, notes }
}

interface DemoteChecked {
  project: Project
  repo: Repository
  main: Worktree
  branch: string
  defaultBranch: string
  target: string
  plan: PromotePlan
  moving: Session[]
}

async function checkDemote(ctx: V2Context, p: any): Promise<DemoteChecked> {
  const projectId = requireString(p.projectId, 'projectId')
  const project = ctx.projects.require(projectId)
  const repo = repoIn(project, p.repoId)
  findRegistered(ctx.store.config.repos, repo.path)
  const row = mainOf(ctx, projectId, repo)
  const { worktree: main, branch } = await checkedOut(ctx, { projectId, worktreeId: row.id })
  const defaultBranch = await gitService.defaultBranch(repo.path)
  if (!defaultBranch) throw bad(`could not tell ${repo.path}'s default branch (main or master) to go back to`)
  if (branch === defaultBranch) throw bad(`the main checkout is already on ${defaultBranch}; there is no branch to move into a worktree`)
  await checkBranchName(repo.path, defaultBranch, true)
  const listed = await viaGit(() => gitService.listWorktrees(repo.path))
  const holder = listed.find((w) => w.branch === defaultBranch && real(w.path) !== real(main.path))
  if (holder) throw codedError('CONFLICT', `${defaultBranch} is checked out at ${holder.path}, so the main checkout can't go back to it; remove that worktree first`)
  const requested = defaultWorktreePath(repo.path, branch)
  const target = ctx.store.guard.check(requested)
  assertNotRepository(ctx.store.config.repos, target, 'path', requested)
  if (existsSync(target)) throw codedError('CONFLICT', `${requested} already exists`)
  const inside = (root: string): boolean => target.startsWith(real(root) + sep)
  if (ctx.store.config.repos.some((r) => inside(r.path)) || repo.worktrees.some((w) => !w.missing && inside(w.path))) {
    throw bad(`${requested} is inside an existing checkout`)
  }
  const { info, moving } = splitSessions(main.sessions, 'it stays in the main checkout')
  const reviewComments = main.review?.comments.length ?? 0
  const plan: PromotePlan = {
    branch,
    mainPath: main.path,
    worktreePath: target,
    mainBranch: defaultBranch,
    dirty: await isDirty(main.path),
    loaded: main.loaded,
    otherLoaded: false,
    sessions: info,
    reviewComments,
    reviewCarried: reviewComments > 0,
    ignored: [],
    ignoredCount: 0,
    hiddenChanges: [],
    hiddenChangesCount: 0
  }
  return { project, repo, main, branch, defaultBranch, target, plan, moving }
}

async function demote(ctx: V2Context, c: DemoteChecked): Promise<PromoteResult> {
  const { project, repo, main, branch, defaultBranch, target, moving } = c
  const movingIds = moving.map((s) => s.id)
  const wasLoaded = main.loaded
  const undo: (() => Promise<unknown>)[] = []
  const unblockMain = ctx.sessions.blockPath(main.path)
  const unblockTarget = ctx.sessions.blockPath(target)
  const backupDir = await mkdtemp(join(tmpdir(), 'trek-promote-index-'))
  let failure: Error | undefined
  try {
    if (wasLoaded && movingIds.length > 0) ctx.sessions.suspendSessions(project.id, movingIds)
    await viaGit(() => gitService.addWorktreeOfCheckedOut(repo.path, target, branch))
    undo.push(() => gitService.removeWorktreeForce(repo.path, target))
    await gitService.linkDirs(repo.path, target, repo.linkedDirs ?? [])
    // What the new worktree links from the main checkout stays there (it is shared, not carried).
    const linked = await gitService.linkedSymlinks(target, repo.linkedDirs ?? [], repo.path)
    const { patch } = await patchOf(main.path, repo, linked)
    if (patch !== '') {
      await viaGit(() => gitService.applyPatch(target, patch).catch((err: Error) => {
        throw new Error(linkedApplyMessage(err.message, repo) ?? err.message)
      }))
    }
    const applied = await patchOf(target, repo)
    if (gitService.patchDigest(applied.patch) !== gitService.patchDigest(patch)) {
      throw codedError('GIT_ERROR', "the uncommitted work in the new worktree does not match the main checkout's after the apply; nothing was changed")
    }
    if (patch !== '') {
      // Off the main checkout: its files back to HEAD, and its index (staged changes) reset, kept to put back.
      const index = resolve(main.path, (await viaGit(() => gitService.git(main.path, ['rev-parse', '--git-path', 'index']))).trim())
      const backup = join(backupDir, 'index')
      const hadIndex = await copyFile(index, backup).then(() => true, (err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT') return false
        throw err
      })
      await viaGit(() => gitService.reverseApplyPatch(main.path, patch))
      undo.push(() => gitService.applyPatch(main.path, patch))
      // Pushed first: a reset that fails part way may have written the index already.
      undo.push(() => (hadIndex ? copyFile(backup, index) : rm(index, { force: true })))
      // With a pathspec: only the index's entries, HEAD left alone.
      await viaGit(() => gitService.git(main.path, ['reset', '-q', '--', '.']))
    }
    // The point of commitment: the main checkout leaves the branch. Its undo is pushed first (a
    // switch that fails part way has written files): back on the branch, its files as HEAD has
    // them; the steps before put its index and work back.
    undo.push(() => gitService.forceCheckoutHead(main.path, { branch, sha: '' }))
    await viaGit(() => gitService.checkout(main.path, defaultBranch))
  } catch (err) {
    failure = withUndoNote(err, await undoAll(undo))
  } finally {
    unblockTarget()
    unblockMain()
    await rm(backupDir, { recursive: true, force: true }).catch(() => {})
  }
  if (failure) {
    if (wasLoaded && movingIds.length > 0) ctx.sessions.resumeSessions(project.id, movingIds)
    await ctx.poller.refresh(repo.path).catch(() => false)
    throw failure
  }

  if (!(await ctx.poller.refresh(repo.path).catch(() => false))) {
    throw codedError('GIT_ERROR', `${branch} is now at ${target}, but the worktrees could not be re-read: ${ctx.poller.warning(repo.path)?.message ?? 'unknown error'}`)
  }
  const notes = await moveHistories(moving, main.path, target)
  let worktreeId = ''
  ctx.projects.apply(project.id, (d) => {
    const r = repoIn(d, repo.id)
    const from = r.worktrees.find((w) => w.id === main.id)
    const created = r.worktrees.find((w) => !w.isMain && real(w.path) === real(target))
    if (!created) throw codedError('GIT_ERROR', `git created ${target} but does not list it`)
    worktreeId = created.id
    if (from) {
      created.sessions.push(...from.sessions.filter((s) => movingIds.includes(s.id)).map(handedOver))
      from.sessions = from.sessions.filter((s) => !movingIds.includes(s.id))
      if (from.review && from.review.comments.length > 0 && carryReview(from, created)) delete from.review
      if (from.prNotice) {
        created.prNotice = from.prNotice
        delete from.prNotice
      }
    }
    // As worktree.create: a branch without a tag gets the first workflow tag.
    const firstTag = d.settings.worktreeTags?.[0]?.id
    const data = Object.hasOwn(r.branchData, branch) ? r.branchData[branch] : undefined
    if (firstTag && !data?.tag && created.branch === branch) r.branchData[branch] = { ...data, tag: firstTag }
  })
  if (wasLoaded && movingIds.length > 0) {
    try {
      ctx.sessions.loadWorktree({ projectId: project.id, worktreeId })
    } catch (err) {
      notes.push(`The sessions moved but could not be resumed: ${(err as Error).message}`)
    }
  }
  ctx.sessions.refreshAttention()
  return { worktreeId, moved: movingIds, notes }
}

/** promote.answer's outcome, checked. */
function checkOutcome(p: any): PromoteOutcome {
  const outcome = requireString(p.outcome, 'outcome')
  if (outcome === 'declined') return { outcome }
  if (outcome === 'promoted') return { outcome, worktreeId: requireString(p.worktreeId, 'worktreeId') }
  if (outcome === 'failed') {
    const error = requireString(p.error, 'error')
    return { outcome, error: error.slice(0, 2000) }
  }
  throw bad('outcome must be declined, promoted or failed')
}

export const promoteHandlers: Record<string, Handler> = {
  'worktree.promote': async (p, ctx): Promise<PromotePlan | PromoteResult> => {
    const dryRun = optionalDryRun(p.dryRun)
    const checked = await checkPromote(ctx, p)
    if (dryRun) return checked.plan
    return locked(checked.repo, async () => promote(ctx, await checkPromote(ctx, p)))
  },

  'worktree.demote': async (p, ctx): Promise<PromotePlan | PromoteResult> => {
    const dryRun = optionalDryRun(p.dryRun)
    const checked = await checkDemote(ctx, p)
    if (dryRun) return checked.plan
    return locked(checked.repo, async () => demote(ctx, await checkDemote(ctx, p)))
  },

  /** A window's answer to promote_to_primary's `promote.request`: the first answer wins. */
  'promote.answer': (p, ctx): { accepted: boolean } => {
    const projectId = requireString(p.projectId, 'projectId')
    ctx.projects.require(projectId)
    const requestId = requireString(p.requestId, 'requestId')
    const outcome = checkOutcome(p)
    return { accepted: ctx.promoteRequests?.answer(projectId, requestId, outcome) ?? false }
  }
}
