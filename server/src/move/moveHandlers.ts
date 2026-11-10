// Moving a worktree between servers (phase 5d), behind the `move` capability. The app relays: it
// asks the source `move.prepare` (what would move), the target `move.candidates` (where it can go),
// unloads the source, takes `move.export` (HEAD, the uncommitted work as one patch, the Claude
// histories, the branch data), pushes the branch through origin (`worktree.push`), hands it all
// to the target's `move.receive` (which builds the worktree, or rolls itself back), and finally
// asks the source `move.finish` to remove its copy, only if nothing changed since the export.
import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import * as gitService from '../../../src/host/gitService.ts'
import { projectDir } from '../../../src/host/claudeSessionService.ts'
import type { BranchData, Project, Repository, Session, Worktree } from '../../../src/shared/model/types'
import {
  MAX_MOVE_HISTORY_BYTES,
  MAX_MOVE_PATCH_BYTES,
  MAX_MOVE_SESSIONS,
  sameOrigin,
  type MoveBranchData,
  type MoveCandidate,
  type MoveExport,
  type MovePlan,
  type MoveReceived,
  type MoveSession,
  type MoveSessionInfo
} from '../../../src/shared/move.ts'
import { isProviderId } from '../../../src/shared/providers/registry.ts'
import { sanitizeLlmSelection } from '../../../src/shared/providers/selection.ts'
import { codedError } from '../errors.ts'
import { assertNotRepository, findRegistered, repoIn } from '../projects/model.ts'
import { realOrResolved as real } from '../repos.ts'
import { MAX_SESSIONS_PER_PROJECT, checkTitle } from '../sessions/limits.ts'
import { isRecord, requireBranch, requireString } from '../validate.ts'
import type { V2Context } from '../v2.ts'
import { checkBranchName, checkedOut, defaultWorktreePath, present } from '../worktreeHandlers.ts'

type Handler = (params: any, ctx: V2Context) => unknown

const bad = (message: string): Error => codedError('BAD_REQUEST', message)
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
const FINGERPRINT = /^[0-9a-f]{64}$/
const MAX_SYSTEM_PROMPT = 100_000
const MAX_NOTE = 100_000
const MB = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(1)} MB`

/** Same head and same patch: nothing changed in the worktree since it was exported. */
function fingerprint(head: string, patch: string): string {
  return createHash('sha256').update(head).update('\0').update(patch).digest('hex')
}

async function viaGit<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation()
  } catch (err) {
    if (err instanceof gitService.NotUtf8PatchError) throw bad(err.message)
    throw codedError('GIT_ERROR', (err as Error).message)
  }
}

/** A Claude session's history file under the worktree's path, if it has one, and its size. */
async function historyOf(worktree: Worktree, session: Session): Promise<{ file: string; size: number } | null> {
  if (session.llm.provider !== 'claude' || !session.agentSessionId || !SESSION_ID.test(session.agentSessionId)) return null
  const file = join(projectDir(worktree.path), `${session.agentSessionId}.jsonl`)
  try {
    const info = await stat(file)
    return info.isFile() ? { file, size: info.size } : null
  } catch {
    return null
  }
}

/** Which of the worktree's sessions are carried: Claude ones with a history, within the limits. */
async function carriedSessions(worktree: Worktree): Promise<{ info: MoveSessionInfo[]; carried: { session: Session; file: string }[] }> {
  const info: MoveSessionInfo[] = []
  const carried: { session: Session; file: string }[] = []
  let total = 0
  for (const session of worktree.sessions) {
    const base = { title: session.title, provider: session.llm.provider }
    if (session.llm.provider !== 'claude') {
      info.push({ ...base, carried: false, reason: 'only Claude sessions move; this one stays behind and is closed' })
      continue
    }
    const history = await historyOf(worktree, session)
    if (!history) {
      info.push({ ...base, carried: false, reason: 'it has no saved conversation yet' })
      continue
    }
    if (carried.length >= MAX_MOVE_SESSIONS) {
      info.push({ ...base, carried: false, reason: `a move carries at most ${MAX_MOVE_SESSIONS} sessions` })
      continue
    }
    if (total + history.size > MAX_MOVE_HISTORY_BYTES) {
      info.push({ ...base, carried: false, reason: `its history (${MB(history.size)}) is over what one move carries (${MB(MAX_MOVE_HISTORY_BYTES)} in all)` })
      continue
    }
    total += history.size
    carried.push({ session, file: history.file })
    info.push({ ...base, carried: true })
  }
  return { info, carried }
}

/** The branch data that moves, its tags by name (each project has its own tag ids). */
function exportBranchData(project: Project, data: BranchData | undefined): MoveBranchData {
  if (!data) return {}
  const out: MoveBranchData = {}
  if (data.note) out.note = data.note
  if (data.ticket) out.ticket = data.ticket
  if (data.pr) out.pr = data.pr
  if (data.prWatch) out.prWatch = true
  const tag = data.tag ? project.settings.worktreeTags?.find((t) => t.id === data.tag)?.name : undefined
  if (tag) out.tag = tag
  const custom = (data.customTags ?? [])
    .map((id) => project.settings.customTags?.find((t) => t.id === id)?.name)
    .filter((name): name is string => !!name)
  if (custom.length > 0) out.customTags = custom
  return out
}

/** The worktree row the source moves: not the main checkout, on a branch, with its project. */
async function source(ctx: V2Context, p: any): Promise<{ project: Project; repo: Repository; worktree: Worktree; branch: string }> {
  const { worktree: row } = present(ctx, p)
  if (row.isMain) throw bad("a repository's main checkout cannot be moved; move a worktree")
  const { repo, worktree, branch } = await checkedOut(ctx, p)
  return { project: ctx.projects.require(p.projectId), repo, worktree, branch }
}

/** Where on this server a branch can't go, or undefined. Re-reads git's worktree list. */
async function blockedReason(ctx: V2Context, repo: Repository, branch: string, path: string): Promise<string | undefined> {
  const listed = await gitService.listWorktrees(repo.path).catch(() => null)
  if (!listed) return `${repo.path} can't be read`
  const holder = listed.find((w) => w.branch === branch)
  if (holder) return `${branch} is already checked out at ${holder.path}`
  if (existsSync(path)) return `${path} already exists`
  try {
    ctx.store.guard.check(path)
  } catch {
    return `${path} is outside the folders this server may use`
  }
  return undefined
}

function checkSessions(value: unknown): MoveSession[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw bad('sessions must be an array')
  if (value.length > MAX_MOVE_SESSIONS) throw bad(`sessions must hold at most ${MAX_MOVE_SESSIONS} entries`)
  let total = 0
  return value.map((raw: unknown, i) => {
    if (!isRecord(raw)) throw bad(`sessions[${i}] must be an object`)
    const title = checkTitle(requireString(raw.title, `sessions[${i}].title`), `sessions[${i}].title`)
    if (!isRecord(raw.llm) || !isProviderId(raw.llm.provider)) throw bad(`sessions[${i}].llm.provider must be a known provider`)
    if (raw.llm.provider !== 'claude') throw bad(`sessions[${i}]: only Claude sessions are carried`)
    const llm = sanitizeLlmSelection(raw.llm)
    if (!llm) throw bad(`sessions[${i}].llm must be an LLM selection`)
    const agentSessionId = requireString(raw.agentSessionId, `sessions[${i}].agentSessionId`)
    if (!SESSION_ID.test(agentSessionId)) throw bad(`sessions[${i}].agentSessionId must be a session id`)
    const history = requireString(raw.history, `sessions[${i}].history`)
    total += Buffer.byteLength(history)
    if (total > MAX_MOVE_HISTORY_BYTES) throw bad(`the histories must be at most ${MB(MAX_MOVE_HISTORY_BYTES)} in all`)
    const session: MoveSession = { title, llm, agentSessionId, history }
    if (raw.sessionTypeName !== undefined) session.sessionTypeName = requireString(raw.sessionTypeName, `sessions[${i}].sessionTypeName`)
    if (raw.systemPrompt !== undefined) {
      const prompt = requireString(raw.systemPrompt, `sessions[${i}].systemPrompt`)
      if (prompt.length > MAX_SYSTEM_PROMPT) throw bad(`sessions[${i}].systemPrompt must be at most ${MAX_SYSTEM_PROMPT} characters`)
      session.systemPrompt = prompt
    }
    if (raw.complete === true) session.complete = true
    return session
  })
}

function checkBranchData(value: unknown): MoveBranchData {
  if (value === undefined) return {}
  if (!isRecord(value)) throw bad('branchData must be an object')
  const out: MoveBranchData = {}
  const text = (key: 'note' | 'tag' | 'ticket' | 'pr', max: number): void => {
    const v = value[key]
    if (v === undefined) return
    if (typeof v !== 'string' || v.length > max) throw bad(`branchData.${key} must be a string of at most ${max} characters`)
    if (v) out[key] = v
  }
  text('note', MAX_NOTE)
  text('tag', 200)
  text('ticket', 200)
  text('pr', 2000)
  if (value.customTags !== undefined) {
    if (!Array.isArray(value.customTags) || value.customTags.length > 100 || value.customTags.some((t) => typeof t !== 'string' || t.length > 200)) {
      throw bad('branchData.customTags must be at most 100 tag names')
    }
    if (value.customTags.length > 0) out.customTags = value.customTags as string[]
  }
  if (value.prWatch !== undefined && typeof value.prWatch !== 'boolean') throw bad('branchData.prWatch must be a boolean')
  if (value.prWatch === true) out.prWatch = true
  return out
}

/** The incoming branch data on top of what the target project already has for the branch. */
function mergeBranchData(project: Project, existing: BranchData | undefined, incoming: MoveBranchData, prWatchable: boolean, dropped: string[]): BranchData {
  const data: BranchData = { ...(existing ?? {}) }
  if (incoming.note) data.note = incoming.note
  if (incoming.ticket) data.ticket = incoming.ticket
  if (incoming.pr) {
    if (data.pr !== incoming.pr) delete data.prWatch
    data.pr = incoming.pr
  }
  if (incoming.tag) {
    const tag = project.settings.worktreeTags?.find((t) => t.name === incoming.tag)
    if (tag) data.tag = tag.id
    else dropped.push(`The tag “${incoming.tag}” is not one of this project's tags`)
  }
  if (incoming.customTags) {
    const ids: string[] = [...(data.customTags ?? [])]
    for (const name of incoming.customTags) {
      const tag = project.settings.customTags?.find((t) => t.name === name)
      if (!tag) dropped.push(`The custom tag “${name}” is not one of this project's tags`)
      else if (!ids.includes(tag.id)) ids.push(tag.id)
    }
    if (ids.length > 0) data.customTags = ids
  }
  if (incoming.prWatch && data.pr) {
    if (prWatchable) data.prWatch ??= {}
    else dropped.push('The pull request is not watched here: gh is not signed in on this server')
  }
  return data
}

export const moveHandlers: Record<string, Handler> = {
  /** What would move, read only: the branch, its origin, which sessions are carried. */
  'move.prepare': async (p, ctx): Promise<MovePlan> => {
    const { repo, worktree, branch } = await source(ctx, p)
    const { info } = await carriedSessions(worktree)
    return {
      branch,
      origin: await gitService.originUrl(repo.path),
      repoName: repo.name,
      dirty: (await gitService.worktreeDirty(worktree.path)) ?? worktree.dirty ?? false,
      loaded: worktree.loaded,
      sessions: info,
      reviewComments: worktree.review?.comments.length ?? 0,
      queuedPrompts: worktree.sessions.reduce((n, s) => n + s.queue.length, 0),
      prWatch: !!(Object.hasOwn(repo.branchData, branch) && repo.branchData[branch].prWatch)
    }
  },

  /** Everything the target needs, from an unloaded worktree. Changes nothing. */
  'move.export': async (p, ctx): Promise<MoveExport & { fingerprint: string }> => {
    const { project, repo, worktree, branch } = await source(ctx, p)
    if (worktree.loaded) throw codedError('IN_USE', `${worktree.path} has running sessions; unload it first`)
    const { patch, headSha } = await viaGit(() => gitService.exportDirtyPatch(worktree.path, repo.linkedDirs ?? []))
    const size = Buffer.byteLength(patch)
    if (size > MAX_MOVE_PATCH_BYTES) {
      throw bad(`the uncommitted changes make a ${MB(size)} patch; a move carries at most ${MB(MAX_MOVE_PATCH_BYTES)}. Commit or remove the large files first`)
    }
    const { info, carried } = await carriedSessions(worktree)
    const sessions: MoveSession[] = []
    const notCarried = info.filter((s) => !s.carried).map((s) => `${s.title}: ${s.reason}`)
    for (const { session, file } of carried) {
      const history = await readFile(file, 'utf8').catch(() => null)
      if (history === null) {
        notCarried.push(`${session.title}: its history could not be read`)
        continue
      }
      const out: MoveSession = { title: session.title, llm: session.llm, agentSessionId: session.agentSessionId!, history }
      const type = session.sessionTypeId ? project.settings.sessionTypes?.find((t) => t.id === session.sessionTypeId) : undefined
      if (type) out.sessionTypeName = type.name
      if (session.systemPrompt) out.systemPrompt = session.systemPrompt
      if (session.status === 'complete') out.complete = true
      sessions.push(out)
    }
    const data = Object.hasOwn(repo.branchData, branch) ? repo.branchData[branch] : undefined
    return { branch, head: headSha, patch, sessions, notCarried, branchData: exportBranchData(project, data), fingerprint: fingerprint(headSha, patch) }
  },

  /**
   * The last step, once the target has the worktree: the source's copy is removed (force) only if
   * its HEAD and uncommitted work are what was exported; otherwise CONFLICT and nothing changes.
   * Its PR watch ends (the target watches it now).
   */
  'move.finish': async (p, ctx): Promise<null> => {
    const expected = requireString(p.fingerprint, 'fingerprint')
    if (!FINGERPRINT.test(expected)) throw bad('fingerprint must be what move.export returned')
    const { repo, worktree, branch } = await source(ctx, p)
    if (worktree.loaded) throw codedError('IN_USE', `${worktree.path} was loaded again after it was copied; it is kept`)
    const unblock = ctx.sessions.blockPath(worktree.path)
    try {
      const { patch, headSha } = await viaGit(() => gitService.exportDirtyPatch(worktree.path, repo.linkedDirs ?? []))
      if (fingerprint(headSha, patch) !== expected) {
        throw codedError('CONFLICT', `${worktree.path} changed after it was copied; it is kept`)
      }
      await viaGit(() => gitService.removeWorktreeForce(repo.path, worktree.path))
      await ctx.poller.refresh(repo.path)
    } finally {
      unblock()
    }
    let watched = false
    ctx.projects.apply(p.projectId, (d) => {
      const r = repoIn(d, repo.id)
      r.worktrees = r.worktrees.filter((w) => w.id !== worktree.id)
      const orderKey = `${repo.id} ${worktree.path}`
      if (d.settings.worktreeOrder) {
        const order = d.settings.worktreeOrder.filter((k) => k !== orderKey)
        if (order.length > 0) d.settings.worktreeOrder = order
        else delete d.settings.worktreeOrder
      }
      const data = Object.hasOwn(r.branchData, branch) ? r.branchData[branch] : undefined
      if (data?.prWatch) {
        watched = true
        const next = { ...data }
        delete next.prWatch
        if (Object.keys(next).length === 0) delete r.branchData[branch]
        else r.branchData[branch] = next
      }
    })
    if (watched) ctx.prWatch?.forget(requireString(p.projectId, 'projectId'), repo.id, branch)
    ctx.sessions.refreshAttention()
    return null
  },

  /** The places on this server the branch can go: repositories with the same origin, in every project. */
  'move.candidates': async (p, ctx): Promise<MoveCandidate[]> => {
    const origin = requireString(p.origin, 'origin')
    const branch = requireBranch(p.branch)
    const origins = new Map<string, string | null>()
    const out: MoveCandidate[] = []
    for (const project of ctx.projects.all()) {
      for (const repo of project.repositories) {
        try {
          findRegistered(ctx.store.config.repos, repo.path)
        } catch {
          continue
        }
        if (!origins.has(repo.path)) origins.set(repo.path, await gitService.originUrl(repo.path))
        if (!sameOrigin(origins.get(repo.path), origin)) continue
        const path = defaultWorktreePath(repo.path, branch)
        const blocked = await blockedReason(ctx, repo, branch, path)
        out.push({ projectId: project.id, projectName: project.name, repoId: repo.id, repoName: repo.name, path, ...(blocked ? { blocked } : {}) })
      }
    }
    return out
  },

  /**
   * Builds the moved worktree: fetches the branch from origin, checks it out at the default path,
   * checks HEAD is the source's, applies the patch, writes the Claude histories under the new path
   * and adds their saved sessions (unloaded) and the branch data. Any failure undoes all of it.
   */
  'move.receive': async (p, ctx): Promise<MoveReceived> => {
    const project = ctx.projects.require(p.projectId)
    const repo = repoIn(project, p.repoId)
    findRegistered(ctx.store.config.repos, repo.path)
    const branch = requireBranch(p.branch)
    await checkBranchName(repo.path, branch, false)
    const head = requireString(p.head, 'head')
    if (!SHA.test(head)) throw bad('head must be a full commit id')
    const patch = p.patch === undefined ? '' : requireString(p.patch, 'patch')
    if (Buffer.byteLength(patch) > MAX_MOVE_PATCH_BYTES) throw bad(`patch must be at most ${MB(MAX_MOVE_PATCH_BYTES)}`)
    const sessions = checkSessions(p.sessions)
    const incoming = checkBranchData(p.branchData)
    const records = project.globalSessions.length + project.repositories.reduce((n, r) => n + r.worktrees.reduce((m, w) => m + w.sessions.length, 0), 0)
    if (records + sessions.length > MAX_SESSIONS_PER_PROJECT) throw codedError('CAPACITY', `a project holds at most ${MAX_SESSIONS_PER_PROJECT} sessions`)

    const target = ctx.store.guard.check(defaultWorktreePath(repo.path, branch))
    assertNotRepository(ctx.store.config.repos, target, 'path')
    const blocked = await blockedReason(ctx, repo, branch, target)
    if (blocked) throw codedError('CONFLICT', blocked)

    const undo: (() => Promise<unknown>)[] = []
    const g = (args: string[]): Promise<string> => gitService.git(repo.path, args)
    try {
      await viaGit(() => g(['fetch', '--no-tags', 'origin', '--', `+refs/heads/${branch}:refs/remotes/origin/${branch}`]))
      const fetched = (await viaGit(() => g(['rev-parse', '--verify', `refs/remotes/origin/${branch}^{commit}`]))).trim()
      if (fetched !== head) throw codedError('CONFLICT', `origin's ${branch} is at ${fetched.slice(0, 8)}, not the source's ${head.slice(0, 8)}: did something else push to it?`)
      const local = await g(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).then((s) => s.trim(), () => null)
      if (local === null) {
        await viaGit(() => g(['branch', '--track', '--', branch, `refs/remotes/origin/${branch}`]))
        undo.push(() => g(['branch', '-D', '--', branch]))
      } else if (local !== head) {
        const behind = await g(['merge-base', '--is-ancestor', local, head]).then(() => true, () => false)
        if (!behind) throw codedError('CONFLICT', `this server's own ${branch} has commits the source's doesn't; reconcile them first`)
        await viaGit(() => g(['update-ref', `refs/heads/${branch}`, head, local]))
        undo.push(() => g(['update-ref', `refs/heads/${branch}`, local, head]))
      }
      const unblock = ctx.sessions.blockPath(target)
      try {
        await viaGit(() => gitService.addWorktreeAt(repo.path, target, branch))
        undo.push(() => gitService.removeWorktreeForce(repo.path, target))
        await gitService.linkDirs(repo.path, target, repo.linkedDirs ?? [])
        const checked = await viaGit(() => gitService.revParseHead(target))
        if (checked !== head) throw codedError('GIT_ERROR', `${target} checked out ${checked.slice(0, 8)}, not ${head.slice(0, 8)}`)
        if (patch.trim()) {
          await viaGit(() => gitService.applyPatch(target, patch))
          if ((await gitService.worktreeDirty(target)) === false) throw codedError('GIT_ERROR', 'the uncommitted changes did not apply')
        }
      } finally {
        unblock()
      }
      const dir = projectDir(target)
      for (const s of sessions) {
        const file = join(dir, `${s.agentSessionId}.jsonl`)
        const before = await readFile(file, 'utf8').catch(() => null)
        await mkdir(dir, { recursive: true })
        await writeFile(file, s.history, { encoding: 'utf8', mode: 0o600 })
        undo.push(() => (before === null ? rm(file, { force: true }) : writeFile(file, before, 'utf8')))
      }
      if (!(await ctx.poller.refresh(repo.path))) {
        throw codedError('GIT_ERROR', `could not re-read the worktrees: ${ctx.poller.warning(repo.path)?.message ?? 'unknown error'}`)
      }
      const dropped: string[] = []
      const watchable = ctx.prWatch?.available() ?? false
      const worktreeId = ctx.projects.apply(p.projectId, (d) => {
        const r = repoIn(d, repo.id)
        const created = r.worktrees.find((w) => !w.isMain && real(w.path) === target)
        if (!created) throw codedError('GIT_ERROR', `git created ${target} but does not list it`)
        for (const s of sessions) {
          const row: Session = { id: randomUUID(), agentSessionId: s.agentSessionId, title: s.title, llm: s.llm, queue: [], status: s.complete ? 'complete' : 'idle' }
          const type = s.sessionTypeName ? d.settings.sessionTypes?.find((t) => t.name === s.sessionTypeName) : undefined
          if (type) row.sessionTypeId = type.id
          else if (s.sessionTypeName) dropped.push(`The session type “${s.sessionTypeName}” of “${s.title}” is not one of this project's`)
          if (s.systemPrompt) row.systemPrompt = s.systemPrompt
          created.sessions.push(row)
        }
        const existing = Object.hasOwn(r.branchData, branch) ? r.branchData[branch] : undefined
        const data = mergeBranchData(d, existing, incoming, watchable, dropped)
        if (Object.keys(data).length > 0) r.branchData[branch] = data
        return created.id
      })
      const watched = Object.hasOwn(repoIn(ctx.projects.require(p.projectId), repo.id).branchData, branch) &&
        !!repoIn(ctx.projects.require(p.projectId), repo.id).branchData[branch].prWatch
      if (watched) ctx.prWatch?.pollSoon(project.id, repo.id, branch)
      return { worktreeId, dropped }
    } catch (err) {
      for (const step of undo.reverse()) await step().catch(() => {})
      await ctx.poller.refresh(repo.path).catch(() => false)
      throw err
    }
  }
}
