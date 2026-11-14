// Promote to primary and its reverse (phase 5e), behind the `promote` capability. One server, so
// each is one request that does everything or puts everything back:
//
// - `worktree.promote`: a worktree's branch is switched to in the repository's main checkout
//   (which must be clean) while the worktree still has it (`--ignore-other-worktrees`), the
//   worktree's uncommitted work (5d's config-proof patch) is applied there and checked by digest,
//   and the worktree's own work checked again: that is the point of commitment. The worktree is
//   removed after it (a removal that fails is a note: the main checkout has the work). Its
//   sessions that can follow (sessionMigrates: Claude and Local) move to the main checkout with
//   their histories and resume there; the main checkout's own sessions keep running, on the new
//   branch.
// - `worktree.demote` ("Promote branch to worktree"): the main checkout's branch gets a new
//   worktree at the default path (`worktree add --force`, while the main checkout still has it),
//   the main checkout's uncommitted work is applied there and checked, taken off the main checkout
//   (`apply -R`, its index reset), and the main checkout switches back to the default branch (the
//   point of commitment). Its sessions that can follow move to the new worktree; the others stay.
//
// Before the first step that changes a checkout, the carried work is saved to a recovery file
// under the server's data dir (0600), deleted once all went well and named in any failure or note.
// Putting things back never discards what the operation did not write itself: a checkout that
// changed meanwhile (the main checkout's own sessions keep running) is left as it is (CONFLICT).
//
// `dryRun: true` answers the plan the confirmation shows, after the same checks.
import { chmod, copyFile, mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import * as gitService from '../../../src/host/gitService.ts'
import { migrateSession } from '../../../src/host/claudeSessionService.ts'
import type { HistoryValue } from '../../../src/shared/model/history.ts'
import type { Project, Repository, Session, Worktree } from '../../../src/shared/model/types'
import { sessionMigrates } from '../../../src/shared/providers/selection.ts'
import { getProvider } from '../../../src/shared/providers/registry.ts'
import {
  MAX_PROMOTE_LISTED_PATHS,
  MAX_PROMOTE_PATCH_BYTES,
  type PromoteClaimResult,
  type PromotePlan,
  type PromoteResult,
  type PromoteSessionInfo,
  type PromoteWindowAnswer
} from '../../../src/shared/promote.ts'
import { codedError } from '../errors.ts'
import { BY_TREK, recordHistory, tagValue } from '../history/record.ts'
import { assertNotRepository, findRegistered, repoIn } from '../projects/model.ts'
import { realOrResolved as real } from '../repos.ts'
import { isInside } from '../../../src/host/pathContainment.ts'
import { requireString } from '../validate.ts'
import type { V2Context } from '../v2.ts'
import { checkBranchName, checkedOut, defaultWorktreePath, locate, present } from '../worktreeHandlers.ts'
import { promoteChanging as changing } from './changing.ts'
import type { PromoteBinding } from './requests.ts'

type Handler = (params: any, ctx: V2Context) => unknown

const bad = (message: string): Error => codedError('BAD_REQUEST', message)

/** For the tests: the repositories a promote or demote is changing now */
export const promoteChanging: Set<string> = changing

/** For the tests: called between the steps named, to change a checkout as a running agent would */
export const promoteTestHooks: {
  /** Promote: just before the main checkout switches to the branch (after its last clean check) */
  beforePromoteSwitch?: (mainPath: string) => Promise<void> | void
  /** Promote: the worktree's work is applied in the main checkout, not yet checked */
  afterApply?: (mainPath: string) => Promise<void> | void
  /** Demote: the main checkout's work is off it, just before it switches to the default branch */
  beforeSwitch?: (mainPath: string) => Promise<void> | void
} = {}

/** How long a promote waits for its stopped agents to exit (then SIGKILL, and a second more) */
const AGENT_EXIT_MS = 5000

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

/** IN_USE when another project has the checkout at `path` loaded (as worktree.remove refuses). */
function assertNotLoadedElsewhere(ctx: V2Context, projectId: string, path: string): void {
  const key = real(path)
  const running = [...ctx.projects.all()]
    .filter((project) => project.id !== projectId && project.repositories.some((r) => r.worktrees.some((w) => w.loaded && real(w.path) === key)))
    .map((project) => project.name)
  if (running.length > 0) throw codedError('IN_USE', `${path} has running sessions in ${running.join(', ')}; unload it there first`)
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
      const { folderKept } = await migrateSession(s.agentSessionId, from, to)
      if (folderKept) {
        notes.push(`The subagent transcripts and tool results of “${s.title}” were left at ${folderKept}: its new folder already had a folder of that name`)
      }
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

/** CONFLICT when another operation (a remove, a move, another promote) has one of the paths blocked. */
function assertNotBlocked(ctx: V2Context, paths: readonly string[]): void {
  for (const path of paths) {
    if (ctx.sessions.isBlocked(path)) throw codedError('CONFLICT', `${path} is being changed by another operation right now; try again once it is done`)
  }
}

/** The ptys these sessions run in now (to wait for their exit once they are stopped). */
function ptysOf(sessions: readonly Session[]): string[] {
  return sessions.map((s) => s.ptyId).filter((id): id is string => !!id)
}

/** Waits for stopped agents to exit; CONFLICT when one is still running after SIGKILL. */
async function agentsGone(ctx: V2Context, ptyIds: readonly string[]): Promise<void> {
  if (ptyIds.length === 0) return
  if (!(await ctx.sessions.terminals.whenGone(ptyIds, AGENT_EXIT_MS))) {
    throw codedError('CONFLICT', 'an agent that was stopped is still running; nothing was changed. Try again in a moment')
  }
}

/**
 * Saves `patch` (the carried work) to `<recovery dir>/<repo>-<branch>-<time>.patch`, 0600, before
 * the first step that changes a checkout. undefined for no work.
 */
async function saveRecovery(ctx: V2Context, repo: Repository, branch: string, patch: string): Promise<string | undefined> {
  if (patch === '') return undefined
  const dir = ctx.promoteRecoveryDir ?? join(tmpdir(), 'trek-promote-recovery')
  const safe = (s: string): string => s.replace(/[^A-Za-z0-9._-]+/g, '-')
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const file = join(dir, `${safe(basename(repo.path))}-${safe(branch)}-${stamp}.patch`)
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 })
    await writeFile(file, patch, { mode: 0o600, flag: 'wx' })
    await chmod(file, 0o600)
  } catch (err) {
    throw codedError('INTERNAL', `could not save a copy of the uncommitted work to ${file} (${(err as Error).message}); nothing was changed`)
  }
  return file
}

/** How long a recovery file is kept: older ones are deleted when the server starts */
export const PROMOTE_RECOVERY_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

/** Deletes the recovery files (`*.patch`) in `dir` older than `maxAgeMs`; what it deleted. Never throws. */
export async function pruneRecoveryFiles(dir: string, maxAgeMs = PROMOTE_RECOVERY_MAX_AGE_MS, now = Date.now()): Promise<string[]> {
  const removed: string[] = []
  const names = await readdir(dir).catch(() => [] as string[])
  for (const name of names) {
    if (!name.endsWith('.patch')) continue
    const file = join(dir, name)
    try {
      const info = await stat(file)
      if (!info.isFile() || now - info.mtimeMs <= maxAgeMs) continue
      await rm(file, { force: true })
      removed.push(file)
    } catch {
      // gone meanwhile, or unreadable: left alone
    }
  }
  return removed
}

/** An undo step that finds the checkout changed by someone else: the undo stops there, nothing more is put back. */
class StopUndo extends Error {}

/** Runs each undo step, newest first, never throwing; a StopUndo ends it (the error says why). */
async function undoAll(undo: (() => Promise<unknown>)[]): Promise<{ failed: string[]; stopped?: string }> {
  const failed: string[] = []
  for (const step of undo.reverse()) {
    try {
      await step()
    } catch (err) {
      if (err instanceof StopUndo) return { failed, stopped: err.message }
      failed.push((err as Error).message)
    }
  }
  return { failed }
}

/** The error a failed promote or demote answers: the first error's code (CONFLICT when the undo stopped), what else went wrong, where the copy is. */
function failureOf(err: unknown, undone: { failed: string[]; stopped?: string }, recovery: string | undefined): Error {
  const e = err as Error & { code?: unknown }
  let message = e.message
  let code = e.code ?? 'GIT_ERROR'
  if (undone.stopped) {
    message = `${message}. ${undone.stopped}`
    code = 'CONFLICT'
  }
  if (undone.failed.length > 0) message = `${message}. Putting things back also failed (${undone.failed.join('; ')}): check the checkouts with git status`
  if (recovery) message = `${message}. A copy of the uncommitted work is saved at ${recovery}`
  if (message === e.message && code === e.code) return e
  const out = new Error(message) as Error & { code?: unknown }
  out.code = code
  return out
}

/** Whether the checkout's uncommitted work is exactly `patch` (by digest); false when it can't be read. */
async function holdsExactly(path: string, repo: Repository, patch: string, linked?: readonly string[]): Promise<boolean> {
  try {
    const now = await patchOf(path, repo, linked)
    return gitService.patchDigest(now.patch) === gitService.patchDigest(patch)
  } catch {
    return false
  }
}

/** The plan's lists of the main checkout's ignored files: those that stay, and those its switch to `branch` overwrites. */
async function mainIgnoredOf(main: Worktree, repo: Repository, switchTo: string): Promise<Pick<PromotePlan, 'mainIgnored' | 'mainIgnoredCount' | 'overwrittenIgnored' | 'overwrittenIgnoredCount'>> {
  const left = await viaGit(() => gitService.leftBehind(main.path, repo.linkedDirs ?? [], MAX_PROMOTE_LISTED_PATHS, repo.path))
  const over = await viaGit(() => gitService.ignoredOverwrittenBy(main.path, switchTo, MAX_PROMOTE_LISTED_PATHS))
  return { mainIgnored: left.ignored, mainIgnoredCount: left.ignoredCount, overwrittenIgnored: over.paths, overwrittenIgnoredCount: over.count }
}

/** Whether git has the worktree at `path` locked (`git worktree lock`): `remove --force` would refuse it after the commitment. */
async function isLocked(repoPath: string, path: string): Promise<boolean> {
  const out = await viaGit(() => gitService.git(repoPath, ['worktree', 'list', '--porcelain']))
  const key = real(path)
  for (const block of out.split('\n\n')) {
    const lines = block.split('\n')
    const at = lines.find((l) => l.startsWith('worktree '))
    if (at && real(at.slice('worktree '.length)) === key) return lines.some((l) => l === 'locked' || l.startsWith('locked '))
  }
  return false
}

interface PromoteChecked {
  project: Project
  repo: Repository
  worktree: Worktree
  main: Worktree
  branch: string
  mainHead: { branch: string | null; sha: string }
  plan: PromotePlan
}

/** `blocked`: refuse paths another operation has blocked (false for the re-check inside the lock, which blocked them itself). */
async function checkPromote(ctx: V2Context, p: any, blocked = true): Promise<PromoteChecked> {
  const { worktree: row } = present(ctx, p)
  if (row.isMain) throw bad('this is already the main checkout')
  const { repo, worktree, branch } = await checkedOut(ctx, p)
  const projectId = requireString(p.projectId, 'projectId')
  assertNotLoadedElsewhere(ctx, projectId, worktree.path)
  if (await isLocked(repo.path, worktree.path)) throw codedError('CONFLICT', `${worktree.path} is locked (git worktree lock); unlock it first`)
  const main = mainOf(ctx, projectId, repo)
  if (blocked) assertNotBlocked(ctx, [worktree.path, main.path])
  const mainHead = await viaGit(() => gitService.headState(main.path))
  if (await isDirty(main.path)) {
    throw codedError('CONFLICT', `the main checkout ${main.path} has uncommitted changes; commit or stash them there first`)
  }
  const dirty = await isDirty(worktree.path)
  const { info } = splitSessions(worktree.sessions, 'it is closed')
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
    hiddenChangesCount: left.hiddenChangesCount,
    ...(await mainIgnoredOf(main, repo, branch))
  }
  return { project: ctx.projects.require(projectId), repo, worktree, main, branch, mainHead, plan }
}

/**
 * The promote itself, inside the repository's lock with both paths blocked: the worktree's stays
 * blocked until its row is gone, the main checkout's until its sessions resume.
 */
async function promote(ctx: V2Context, c: PromoteChecked, unblock: { main: () => void; worktree: () => void }): Promise<PromoteResult> {
  const { project, repo, worktree, main, branch, mainHead } = c
  // Read after the paths were blocked: nothing can load the worktree or start a session in it now.
  const before = locate(ctx.projects.require(project.id), worktree.id).worktree
  const wasLoaded = before.loaded
  const undo: (() => Promise<unknown>)[] = []
  let recovery: string | undefined
  let failure: Error | undefined
  const notes: string[] = []
  let removalFailed = false
  try {
    // Its agents stop first, and are gone, before its work is packed: none may write to it now.
    const ptys = ptysOf(before.sessions)
    ctx.sessions.unloadWorktree({ projectId: project.id, worktreeId: worktree.id })
    await agentsGone(ctx, ptys)
    const { patch } = await patchOf(worktree.path, repo)
    recovery = await saveRecovery(ctx, repo, branch, patch)
    // The main checkout's own sessions keep running: it is checked once more just before the switch.
    if (await isDirty(main.path)) {
      throw codedError('CONFLICT', `the main checkout ${main.path} has uncommitted changes (one of its sessions wrote to it while the promote ran); commit or stash them there first`)
    }
    // Pushed before the switch: one that fails part way has written files already. The main
    // checkout was clean; whether the switch went through or not, only a main checkout that still
    // holds nothing uncommitted is forced back, and only when its HEAD moved (a switch git refused
    // because one of its sessions edited a file meanwhile is left as it is, with that edit).
    const changed = `the main checkout ${main.path} changed while the promote ran, so it was not put back: it is on ${branch} with the worktree's uncommitted work and those changes (check it with git status); the worktree ${worktree.path} is unchanged`
    const changedUnswitched = `the main checkout ${main.path} changed while the promote ran (one of its own sessions wrote to it), so it was not put back: it is left as it is, with those changes (check it with git status); the worktree ${worktree.path} is unchanged`
    undo.push(async () => {
      const head = await gitService.headState(main.path).catch(() => null)
      const moved = !head || head.branch !== mainHead.branch || head.sha !== mainHead.sha
      if (!(await holdsExactly(main.path, repo, ''))) throw new StopUndo(moved ? changed : changedUnswitched)
      if (moved) await gitService.forceCheckoutHead(main.path, mainHead)
    })
    await promoteTestHooks.beforePromoteSwitch?.(main.path)
    await viaGit(() => gitService.checkoutIgnoringOtherWorktrees(main.path, branch))
    if (patch !== '') {
      await viaGit(() => gitService.applyPatch(main.path, patch))
      undo.push(async () => {
        if (!(await holdsExactly(main.path, repo, patch))) throw new StopUndo(changed)
        await gitService.reverseApplyPatch(main.path, patch)
      })
    }
    await promoteTestHooks.afterApply?.(main.path)
    // The work as the main checkout now has it must be the worktree's, exactly (5d's check)…
    if (!(await holdsExactly(main.path, repo, patch))) {
      throw codedError('GIT_ERROR', "the uncommitted work in the main checkout does not match the worktree's after the apply")
    }
    // …and the worktree's must not have moved since it was packed.
    if (!(await holdsExactly(worktree.path, repo, patch))) {
      throw codedError('CONFLICT', `${worktree.path} changed while the promote ran`)
    }
    // The point of commitment: the main checkout holds the branch and its work. The worktree goes
    // after it; a removal that fails (a folder it may not delete) is a note, never an undo.
    try {
      await gitService.removeWorktreeForce(repo.path, worktree.path, repo.linkedDirs ?? [])
    } catch (err) {
      removalFailed = true
      notes.push(
        `The worktree ${worktree.path} could not be fully removed (${(err as Error).message.trim()}); its work is in the main checkout; remove it yourself` +
          (recovery ? `. A copy of the work is saved at ${recovery}` : '')
      )
    }
  } catch (err) {
    failure = failureOf(err, await undoAll(undo), recovery)
  }
  if (failure) {
    unblock.main()
    unblock.worktree()
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
  // The sessions as they are now (stopped, none added: the path was blocked).
  const from = repoIn(ctx.projects.require(project.id), repo.id).worktrees.find((w) => w.id === worktree.id)?.sessions ?? before.sessions
  const { moving } = splitSessions(from, 'it is closed')
  notes.push(...(await moveHistories(moving, worktree.path, main.path)))
  for (const s of from) if (!sessionMigrates(s)) notes.push(`“${s.title}” was closed: ${getProvider(s.llm.provider).label} can't follow a worktree to another folder`)
  let movedIds = moving.map((s) => s.id)
  let mainLoaded = false
  // After the commitment nothing throws: records that can't be updated are a note.
  try {
    ctx.projects.apply(project.id, (d) => {
      const r = repoIn(d, repo.id)
      const fromRow = r.worktrees.find((w) => w.id === worktree.id)
      const to = r.worktrees.find((w) => w.id === main.id)
      if (to && fromRow) {
        to.sessions.push(...fromRow.sessions.filter((s) => movedIds.includes(s.id)).map(handedOver))
        if (fromRow.review && fromRow.review.comments.length > 0 && !carryReview(fromRow, to)) {
          notes.push(`The worktree's review draft (${fromRow.review.comments.length} comments) was dropped: the main checkout has a draft of its own`)
        }
        if (fromRow.prNotice && !to.prNotice) to.prNotice = fromRow.prNotice
        mainLoaded = to.loaded
      }
      r.worktrees = r.worktrees.filter((w) => w.id !== worktree.id)
      dropOrderKey(d, repo.id, worktree.path)
    })
  } catch (err) {
    movedIds = []
    notes.push(`${branch} is now in the main checkout, but the project's records could not be updated (${(err as Error).message}); its sessions did not move: reopen the project`)
  }
  unblock.worktree()
  unblock.main()
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
  // The copy is kept while the worktree's folder is still there, for the user to check against.
  if (recovery && !removalFailed) await rm(recovery, { force: true }).catch(() => {})
  return { worktreeId: main.id, moved: movedIds, notes, ...(recovery && removalFailed ? { recoveryFile: recovery } : {}) }
}

interface DemoteChecked {
  project: Project
  repo: Repository
  main: Worktree
  branch: string
  defaultBranch: string
  target: string
  plan: PromotePlan
}

/** `blocked` as checkPromote's. */
async function checkDemote(ctx: V2Context, p: any, blocked = true): Promise<DemoteChecked> {
  const projectId = requireString(p.projectId, 'projectId')
  const project = ctx.projects.require(projectId)
  const repo = repoIn(project, p.repoId)
  findRegistered(ctx.store.config.repos, repo.path)
  const row = mainOf(ctx, projectId, repo)
  const { worktree: main, branch } = await checkedOut(ctx, { projectId, worktreeId: row.id })
  assertNotLoadedElsewhere(ctx, projectId, main.path)
  const defaultBranch = await gitService.defaultBranch(repo.path)
  if (!defaultBranch) throw bad(`could not tell ${repo.path}'s default branch (main or master) to go back to`)
  if (branch === defaultBranch) throw bad(`the main checkout is already on ${defaultBranch}; there is no branch to move into a worktree`)
  await checkBranchName(repo.path, defaultBranch, true)
  const listed = await viaGit(() => gitService.listWorktrees(repo.path))
  const holder = listed.find((w) => w.branch === defaultBranch && real(w.path) !== real(main.path))
  if (holder) throw codedError('CONFLICT', `${defaultBranch} is checked out at ${holder.path}, so the main checkout can't go back to it; remove that worktree first`)
  // `worktree add --force` would put the branch in a third checkout.
  const other = listed.find((w) => w.branch === branch && real(w.path) !== real(main.path))
  if (other) throw codedError('CONFLICT', `${branch} is checked out at ${other.path} too; remove that worktree, or promote it, instead`)
  const requested = defaultWorktreePath(repo.path, branch)
  const target = ctx.store.guard.check(requested)
  assertNotRepository(ctx.store.config.repos, target, 'path', requested)
  if (blocked) assertNotBlocked(ctx, [main.path, target])
  if (existsSync(target)) throw codedError('CONFLICT', `${requested} already exists`)
  const inside = (root: string): boolean => isInside(real(root), target, process.platform, true)
  if (ctx.store.config.repos.some((r) => inside(r.path)) || repo.worktrees.some((w) => !w.missing && inside(w.path))) {
    throw bad(`${requested} is inside an existing checkout`)
  }
  const { info } = splitSessions(main.sessions, 'it stays in the main checkout')
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
    hiddenChangesCount: 0,
    ...(await mainIgnoredOf(main, repo, defaultBranch))
  }
  return { project, repo, main, branch, defaultBranch, target, plan }
}

/** The demote itself, inside the repository's lock with both paths blocked; `unblock` releases them before the sessions resume. */
async function demote(ctx: V2Context, c: DemoteChecked, unblock: () => void): Promise<PromoteResult> {
  const { project, repo, main, branch, defaultBranch, target } = c
  // Read after the paths were blocked: no session can start in the main checkout now.
  const before = locate(ctx.projects.require(project.id), main.id).worktree
  const { moving } = splitSessions(before.sessions, 'it stays in the main checkout')
  const movingIds = moving.map((s) => s.id)
  const wasLoaded = before.loaded
  const undo: (() => Promise<unknown>)[] = []
  const backupDir = await mkdtemp(join(tmpdir(), 'trek-promote-index-'))
  let recovery: string | undefined
  let failure: Error | undefined
  try {
    if (movingIds.length > 0) {
      const ptys = ptysOf(moving)
      ctx.sessions.suspendSessions(project.id, movingIds)
      await agentsGone(ctx, ptys)
    }
    await viaGit(() => gitService.addWorktreeOfCheckedOut(repo.path, target, branch))
    // The new worktree is removed only once the main checkout has its work back (it may be the
    // only copy besides the recovery file): else the undo stops there and keeps it.
    let carried: { patch: string; linked: string[] } | undefined
    undo.push(async () => {
      if (carried && carried.patch !== '' && !(await holdsExactly(main.path, repo, carried.patch, carried.linked))) {
        throw new StopUndo(
          `the main checkout ${main.path} does not have its uncommitted work back (it changed, or putting it back failed), so it was not put back and the new worktree ${target}, which has the work, was kept (check both with git status)`
        )
      }
      await gitService.removeWorktreeForce(repo.path, target, repo.linkedDirs ?? [])
    })
    for (const warning of await gitService.linkDirs(repo.path, target, repo.linkedDirs ?? [])) console.warn(`linkedDirs in ${target}: ${warning}`)
    // What the new worktree links from the main checkout stays there (it is shared, not carried).
    const linked = await gitService.linkedSymlinks(target, repo.linkedDirs ?? [], repo.path)
    const { patch } = await patchOf(main.path, repo, linked)
    carried = { patch, linked }
    recovery = await saveRecovery(ctx, repo, branch, patch)
    if (patch !== '') {
      await viaGit(() => gitService.applyPatch(target, patch).catch((err: Error) => {
        throw new Error(linkedApplyMessage(err.message, repo) ?? err.message)
      }))
    }
    if (!(await holdsExactly(target, repo, patch))) {
      throw codedError('GIT_ERROR', "the uncommitted work in the new worktree does not match the main checkout's after the apply")
    }
    if (patch !== '') {
      // The main checkout's work must not have moved since it was packed (its other sessions run on).
      if (!(await holdsExactly(main.path, repo, patch, linked))) throw codedError('CONFLICT', `${main.path} changed while the demote ran`)
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
    await promoteTestHooks.beforeSwitch?.(main.path)
    // The point of commitment: the main checkout leaves the branch. Its undo is pushed first: a
    // main checkout still on the branch with nothing uncommitted needs nothing; one that holds
    // anything else (a switch that failed part way, or a write by one of its running sessions) is
    // left as it is, never discarded: the new worktree has its work.
    undo.push(async () => {
      const head = await gitService.headState(main.path).catch(() => null)
      if (head?.branch === branch && (await holdsExactly(main.path, repo, '', linked))) return
      throw new StopUndo(
        `the main checkout ${main.path} changed while the demote ran, so it was not put back: it is left as it is (check it with git status), without its uncommitted work, which is in the new worktree ${target}`
      )
    })
    await viaGit(() => gitService.checkout(main.path, defaultBranch))
  } catch (err) {
    failure = failureOf(err, await undoAll(undo), recovery)
  } finally {
    unblock()
    await rm(backupDir, { recursive: true, force: true }).catch(() => {})
  }
  if (failure) {
    if (wasLoaded && movingIds.length > 0) {
      try {
        ctx.sessions.resumeSessions(project.id, movingIds)
      } catch (err) {
        console.error(`could not resume the main checkout's sessions after a failed demote`, err)
      }
    }
    await ctx.poller.refresh(repo.path).catch(() => false)
    throw failure
  }

  // After the commitment nothing throws: what can't be done is a note.
  const notes: string[] = []
  const listed = (await ctx.poller.refresh(repo.path).catch(() => false)) || (await ctx.poller.refresh(repo.path).catch(() => false))
  const created = listed ? repoIn(ctx.projects.require(project.id), repo.id).worktrees.find((w) => !w.isMain && real(w.path) === real(target)) : undefined
  if (!created) {
    notes.push(
      `${branch} is now at ${target}, but the worktrees could not be re-read (${ctx.poller.warning(repo.path)?.message ?? 'it is not listed'}); its sessions stayed in the main checkout`
    )
    if (wasLoaded && movingIds.length > 0) {
      try {
        ctx.sessions.resumeSessions(project.id, movingIds)
      } catch (err) {
        notes.push(`The sessions could not be resumed: ${(err as Error).message}`)
      }
    }
    ctx.sessions.refreshAttention()
    if (recovery) await rm(recovery, { force: true }).catch(() => {})
    return { worktreeId: main.id, moved: [], notes }
  }
  notes.push(...(await moveHistories(moving, main.path, target)))
  const worktreeId = created.id
  let moved = movingIds
  let tagged: HistoryValue | undefined
  try {
    ctx.projects.apply(project.id, (d) => {
      const r = repoIn(d, repo.id)
      const from = r.worktrees.find((w) => w.id === main.id)
      const to = r.worktrees.find((w) => w.id === worktreeId)
      if (!to) return
      if (from) {
        to.sessions.push(...from.sessions.filter((s) => movingIds.includes(s.id)).map(handedOver))
        from.sessions = from.sessions.filter((s) => !movingIds.includes(s.id))
        if (from.review && from.review.comments.length > 0 && carryReview(from, to)) delete from.review
        if (from.prNotice) {
          to.prNotice = from.prNotice
          delete from.prNotice
        }
      }
      // As worktree.create: a branch without a tag gets the first workflow tag.
      const firstTag = d.settings.worktreeTags?.[0]?.id
      const data = Object.hasOwn(r.branchData, branch) ? r.branchData[branch] : undefined
      if (firstTag && !data?.tag && to.branch === branch) {
        r.branchData[branch] = { ...data, tag: firstTag }
        tagged = tagValue(d.settings.worktreeTags, firstTag)
      }
    })
  } catch (err) {
    moved = []
    notes.push(`${branch} is now at ${target}, but the project's records could not be updated (${(err as Error).message}); its sessions stayed in the main checkout`)
  }
  if (tagged) recordHistory(ctx, project.id, repo.id, branch, [{ kind: 'status', to: tagged }], BY_TREK)
  if (wasLoaded && movingIds.length > 0) {
    try {
      if (moved.length > 0) ctx.sessions.loadWorktree({ projectId: project.id, worktreeId })
      else ctx.sessions.resumeSessions(project.id, movingIds)
    } catch (err) {
      notes.push(`The sessions could not be resumed: ${(err as Error).message}`)
    }
  }
  ctx.sessions.refreshAttention()
  if (recovery) await rm(recovery, { force: true }).catch(() => {})
  return { worktreeId, moved, notes }
}

/** promote.answer's outcome, checked: a window declines, doesn't list the worktree, or (its claimant) says its teardown failed. */
function checkOutcome(p: any): PromoteWindowAnswer {
  const outcome = requireString(p.outcome, 'outcome')
  if (outcome === 'declined' || outcome === 'unknown-worktree') return { outcome }
  if (outcome === 'failed') {
    const error = requireString(p.error, 'error')
    return { outcome, error: error.slice(0, 2000) }
  }
  if (outcome === 'promoted') throw bad('a promote settles its request itself: send worktree.promote with the requestId')
  throw bad('outcome must be declined, failed or unknown-worktree')
}

function optionalRequestId(value: unknown): string | undefined {
  if (value === undefined) return undefined
  return requireString(value, 'requestId')
}

function optionalClaimToken(value: unknown): string | undefined {
  if (value === undefined) return undefined
  const token = requireString(value, 'claimToken')
  if (token.length > 100) throw bad('claimToken is too long')
  return token
}

export const promoteHandlers: Record<string, Handler> = {
  /**
   * `requestId` (promote_to_primary's request this promote answers): the request is bound to it,
   * and settled with its result, whatever the window does next.
   */
  'worktree.promote': async (p, ctx): Promise<PromotePlan | PromoteResult> => {
    const dryRun = optionalDryRun(p.dryRun)
    const requestId = optionalRequestId(p.requestId)
    if (dryRun) return (await checkPromote(ctx, p)).plan
    let binding: PromoteBinding | undefined
    if (requestId !== undefined) {
      const projectId = requireString(p.projectId, 'projectId')
      ctx.projects.require(projectId)
      if (!ctx.promoteRequests) throw codedError('NOT_FOUND', 'No such promote request')
      binding = ctx.promoteRequests.bind(projectId, requestId, requireString(p.worktreeId, 'worktreeId'), ctx.subscriber, optionalClaimToken(p.claimToken))
    }
    try {
      const first = await checkPromote(ctx, p)
      const { result, checked } = await locked(first.repo, async () => {
        // Again, with no await since: no other operation blocks them between this and ours.
        assertNotBlocked(ctx, [first.worktree.path, first.main.path])
        const unblockWorktree = ctx.sessions.blockPath(first.worktree.path)
        const unblockMain = ctx.sessions.blockPath(first.main.path)
        try {
          const checked = await checkPromote(ctx, p, false)
          return { result: await promote(ctx, checked, { main: unblockMain, worktree: unblockWorktree }), checked }
        } finally {
          unblockMain()
          unblockWorktree()
        }
      })
      binding?.settle({ outcome: 'promoted', worktreeId: result.worktreeId })
      recordHistory(ctx, requireString(p.projectId, 'projectId'), checked.repo.id, checked.branch, [{ kind: 'promoted' }], binding?.attribution ?? ctx.attribution)
      return result
    } catch (err) {
      binding?.settle({ outcome: 'failed', error: (err as Error).message.slice(0, 2000) })
      throw err
    }
  },

  'worktree.demote': async (p, ctx): Promise<PromotePlan | PromoteResult> => {
    const dryRun = optionalDryRun(p.dryRun)
    const first = await checkDemote(ctx, p)
    if (dryRun) return first.plan
    const { result, checked } = await locked(first.repo, async () => {
      assertNotBlocked(ctx, [first.main.path, first.target])
      const unblockMain = ctx.sessions.blockPath(first.main.path)
      const unblockTarget = ctx.sessions.blockPath(first.target)
      const unblock = (): void => {
        unblockTarget()
        unblockMain()
      }
      try {
        const checked = await checkDemote(ctx, p, false)
        return { result: await demote(ctx, checked, unblock), checked }
      } finally {
        unblock()
      }
    })
    recordHistory(ctx, requireString(p.projectId, 'projectId'), checked.repo.id, checked.branch, [{ kind: 'demoted' }])
    return result
  },

  /** This connection can confirm promote_to_primary's requests for the project (`listen: false`: no longer). */
  'promote.listen': (p, ctx): null => {
    const projectId = requireString(p.projectId, 'projectId')
    ctx.projects.require(projectId)
    if (p.listen !== undefined && typeof p.listen !== 'boolean') throw bad('listen must be a boolean')
    if (!ctx.promoteRequests) throw codedError('BAD_REQUEST', 'this server does not ask windows to confirm promotes')
    ctx.promoteRequests.listen(projectId, ctx.subscriber, p.listen !== false)
    return null
  },

  /**
   * A window's user confirmed a `promote.request`: the first claim wins (before any teardown), with
   * a `claimToken`. Repeated by the claimant (or with the token from its new connection) it refreshes the claim.
   */
  'promote.claim': (p, ctx): PromoteClaimResult => {
    const projectId = requireString(p.projectId, 'projectId')
    ctx.projects.require(projectId)
    const requestId = requireString(p.requestId, 'requestId')
    const claimToken = optionalClaimToken(p.claimToken)
    return ctx.promoteRequests?.claim(projectId, requestId, ctx.subscriber, claimToken) ?? { accepted: false }
  },

  /** A window's decline (or, from its claimant before its promote starts, a teardown that failed). */
  'promote.answer': (p, ctx): { accepted: boolean } => {
    const projectId = requireString(p.projectId, 'projectId')
    ctx.projects.require(projectId)
    const requestId = requireString(p.requestId, 'requestId')
    const outcome = checkOutcome(p)
    const claimToken = optionalClaimToken(p.claimToken)
    return { accepted: ctx.promoteRequests?.answer(projectId, requestId, outcome, ctx.subscriber, claimToken) ?? false }
  }
}
