// Moving a worktree between servers (phase 5d), behind the `move` capability. The app relays: it
// asks the source `move.prepare` (what would move), the target `move.candidates` (where it can go),
// unloads the source, takes `move.export` (HEAD, the uncommitted work as one patch, the carried
// Claude sessions with each history's size and hash, the branch data), pushes the branch through
// origin (`worktree.push`), copies each history in chunks (`move.history` on the source,
// `move.upload` into a `move.begin` transfer on the target), hands the rest to the target's
// `move.receive` (which builds the worktree, or rolls itself back), and finally asks the source
// `move.finish` to remove its copy, only if nothing changed since the export.
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, existsSync } from 'node:fs'
import { copyFile, chmod, mkdir, open, rm, rmdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import * as gitService from '../../../src/host/gitService.ts'
import { projectDir } from '../../../src/host/claudeSessionService.ts'
import type { BranchData, Project, Repository, Session, Worktree } from '../../../src/shared/model/types'
import {
  MAX_MOVE_CHUNK_BYTES,
  MAX_MOVE_FRAME_JSON_BYTES,
  MAX_MOVE_HISTORY_SESSION_BYTES,
  MAX_MOVE_LISTED_PATHS,
  MAX_MOVE_PATCH_BYTES,
  MAX_MOVE_SESSIONS,
  MOVE_FETCH_TIMEOUT_MS,
  MOVE_UNDO_MS,
  sameOrigin,
  type MoveBranchData,
  type MoveCandidate,
  type MoveExport,
  type MoveHistoryChunk,
  type MovePlan,
  type MoveReceived,
  type MoveSession,
  type MoveSessionInfo
} from '../../../src/shared/move.ts'
import { isProviderId } from '../../../src/shared/providers/registry.ts'
import { sanitizeLlmSelection } from '../../../src/shared/providers/selection.ts'
import { MAX_HISTORY_PER_BRANCH, sanitizeHistoryEvent, type HistoryEvent } from '../../../src/shared/model/history.ts'
import { codedError } from '../errors.ts'
import { recordHistory } from '../history/record.ts'
import { assertNotPromoting } from '../promote/changing.ts'
import { assertNotRepository, findRegistered, repoIn } from '../projects/model.ts'
import { realOrResolved as real } from '../repos.ts'
import { MAX_SESSIONS_PER_PROJECT, checkTitle } from '../sessions/limits.ts'
import { isRecord, requireBranch, requireString } from '../validate.ts'
import type { V2Context } from '../v2.ts'
import { checkBranchName, checkedOut, defaultWorktreePath, present } from '../worktreeHandlers.ts'
import { moveTransfers, type StagedHistories } from './transfers.ts'

type Handler = (params: any, ctx: V2Context) => unknown

const bad = (message: string): Error => codedError('BAD_REQUEST', message)

/**
 * move.receive's `history`: a list (else BAD_REQUEST); entries that are not well-formed are dropped,
 * as are all but the newest MAX_HISTORY_PER_BRANCH (history is cosmetic: it never fails a move).
 * `unreadable` / `overCap`: how many were left out for each reason.
 */
function checkHistory(value: unknown): { events: HistoryEvent[]; unreadable: number; overCap: number } {
  if (value === undefined) return { events: [], unreadable: 0, overCap: 0 }
  if (!Array.isArray(value)) throw bad('history must be a list of history events')
  const valid = value.map(sanitizeHistoryEvent).filter((e): e is HistoryEvent => e !== null)
  const events = valid.slice(-MAX_HISTORY_PER_BRANCH)
  return { events, unreadable: value.length - valid.length, overCap: valid.length - events.length }
}
/** A server name: trimmed, cut to 200 characters; a non-string is BAD_REQUEST */
const optionalServerName = (value: unknown, field: string): string | undefined => {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw bad(`${field} must be a server name`)
  return value.trim().slice(0, 200) || undefined
}
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
const FINGERPRINT = /^[0-9a-f]{64}$/
const MAX_SYSTEM_PROMPT = 100_000
const MAX_NOTE = 100_000
const MB = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(1)} MB`
const SHA256 = /^[0-9a-f]{64}$/

/** A file's sha256, streamed */
function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    createReadStream(file).on('data', (b) => hash.update(b)).on('error', reject).on('end', () => resolve(hash.digest('hex')))
  })
}

/**
 * Same head, same patch and the same carried histories (each one's session id, size and sha256):
 * nothing changed in the worktree, nor in a conversation that moves, since it was exported.
 */
function fingerprint(head: string, patch: string, histories: readonly { agentSessionId: string; size: number; sha256: string }[]): string {
  const hash = createHash('sha256').update(head).update('\0').update(patch)
  for (const h of histories) hash.update('\0').update(`${h.agentSessionId} ${h.size} ${h.sha256}`)
  return hash.digest('hex')
}

async function viaGit<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation()
  } catch (err) {
    if (err instanceof gitService.NotUtf8PatchError || err instanceof gitService.PatchTooBigError || err instanceof gitService.NestedRepoError) throw bad(err.message)
    throw codedError('GIT_ERROR', (err as Error).message)
  }
}

/** The worktree's patch (exportDirtyPatch, MAX_MOVE_PATCH_BYTES), the repository's linkedDirs that are symlinks here left out. */
function dirtyPatch(path: string, repo: Repository): Promise<{ patch: string; headSha: string }> {
  return viaGit(() => gitService.exportDirtyPatch(path, repo.linkedDirs ?? [], { maxBytes: MAX_MOVE_PATCH_BYTES, repoPath: repo.path }))
}

/**
 * What `move.unreceive` needs to undo one `move.receive`, kept in memory for MOVE_UNDO_MS under
 * the receive's `undoToken`.
 */
interface Receipt {
  projectId: string
  repoId: string
  branch: string
  worktreeId: string
  /** The new worktree's path (real) */
  path: string
  head: string
  /** patchDigest of the work the receive checked in */
  digest: string
  /** The branch data the project had for the branch before (a copy); undefined: none */
  previous: BranchData | undefined
  /** The receive created the local branch (deleted again if still at head) */
  createdBranch: boolean
  /** The receive fast-forwarded the local branch from this commit (moved back if still at head) */
  movedFrom: string | null
  /** The history entries the receive added (taken out again by move.unreceive) */
  historyIds?: string[]
  /** History files the receive created, and the history folder if it created that */
  createdFiles: string[]
  createdDir: string | null
  expires: number
}

const receipts = new Map<string, Receipt>()

function sweepReceipts(now = Date.now()): void {
  for (const [token, r] of receipts) if (r.expires <= now) receipts.delete(token)
}

/** Repositories (real path) with a branch being received (or a receive of it undone) right now: `${path}\0${branch}` */
const receiving = new Set<string>()
/** For the tests: the receives in progress */
export const moveReceiving: Set<string> = receiving

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
async function carriedSessions(worktree: Worktree): Promise<{ info: MoveSessionInfo[]; carried: { session: Session; file: string; size: number }[] }> {
  const info: MoveSessionInfo[] = []
  const carried: { session: Session; file: string; size: number }[] = []
  for (const session of worktree.sessions) {
    const same = carried.find((c) => c.session.agentSessionId === session.agentSessionId)
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
    if (same) {
      info.push({ ...base, carried: false, reason: `it resumes the same conversation as “${same.session.title}”, which is carried` })
      continue
    }
    if (carried.length >= MAX_MOVE_SESSIONS) {
      info.push({ ...base, carried: false, reason: `a move carries at most ${MAX_MOVE_SESSIONS} sessions` })
      continue
    }
    if (history.size > MAX_MOVE_HISTORY_SESSION_BYTES) {
      info.push({ ...base, carried: false, reason: `its history (${MB(history.size)}) is over what one session carries (${MB(MAX_MOVE_HISTORY_SESSION_BYTES)})` })
      continue
    }
    carried.push({ session, file: history.file, size: history.size })
    info.push({ ...base, carried: true })
  }
  return { info, carried }
}

/** The carried sessions with each history's sha256 (null: it could not be read, so it is not carried). */
async function hashedSessions(worktree: Worktree): Promise<{ info: MoveSessionInfo[]; carried: { session: Session; file: string; size: number; sha256: string | null }[] }> {
  const { info, carried } = await carriedSessions(worktree)
  const hashed = []
  for (const c of carried) hashed.push({ ...c, sha256: await sha256File(c.file).catch(() => null) })
  return { info, carried: hashed }
}

/** What the fingerprint takes of the carried histories: the readable ones, in order. */
function fingerprinted(carried: readonly { session: Session; size: number; sha256: string | null }[]): { agentSessionId: string; size: number; sha256: string }[] {
  return carried.filter((c) => c.sha256 !== null).map((c) => ({ agentSessionId: c.session.agentSessionId!, size: c.size, sha256: c.sha256! }))
}

/** The branch data that moves, its tags by name (each project has its own tag ids). */
function exportBranchData(project: Project, data: BranchData | undefined): MoveBranchData {
  if (!data) return {}
  const out: MoveBranchData = {}
  if (data.note) out.note = data.note
  if (data.ticket) out.ticket = data.ticket
  if (data.pr) out.pr = data.pr
  if (data.prWatch) out.prWatch = true
  if (data.env) out.env = data.env
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
  assertNotPromoting(repo.path)
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
  const seen = new Set<string>()
  return value.map((raw: unknown, i) => {
    if (!isRecord(raw)) throw bad(`sessions[${i}] must be an object`)
    const title = checkTitle(requireString(raw.title, `sessions[${i}].title`), `sessions[${i}].title`)
    if (!isRecord(raw.llm) || !isProviderId(raw.llm.provider)) throw bad(`sessions[${i}].llm.provider must be a known provider`)
    if (raw.llm.provider !== 'claude') throw bad(`sessions[${i}]: only Claude sessions are carried`)
    const llm = sanitizeLlmSelection(raw.llm)
    if (!llm) throw bad(`sessions[${i}].llm must be an LLM selection`)
    const agentSessionId = requireString(raw.agentSessionId, `sessions[${i}].agentSessionId`)
    if (!SESSION_ID.test(agentSessionId)) throw bad(`sessions[${i}].agentSessionId must be a session id`)
    if (seen.has(agentSessionId)) throw bad(`sessions[${i}].agentSessionId repeats another`)
    seen.add(agentSessionId)
    const historyBytes = raw.historyBytes
    if (!Number.isInteger(historyBytes) || (historyBytes as number) < 1 || (historyBytes as number) > MAX_MOVE_HISTORY_SESSION_BYTES) {
      throw bad(`sessions[${i}].historyBytes must be 1 to ${MAX_MOVE_HISTORY_SESSION_BYTES}`)
    }
    const historySha256 = requireString(raw.historySha256, `sessions[${i}].historySha256`)
    if (!SHA256.test(historySha256)) throw bad(`sessions[${i}].historySha256 must be a sha256 in hex`)
    const session: MoveSession = { title, llm, agentSessionId, historyBytes: historyBytes as number, historySha256 }
    if (raw.sessionTypeName !== undefined) {
      session.sessionTypeName = checkTitle(requireString(raw.sessionTypeName, `sessions[${i}].sessionTypeName`), `sessions[${i}].sessionTypeName`)
    }
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
  const text = (key: 'note' | 'tag' | 'ticket' | 'pr' | 'env', max: number): void => {
    const v = value[key]
    if (v === undefined) return
    if (typeof v !== 'string' || v.length > max) throw bad(`branchData.${key} must be a string of at most ${max} characters`)
    if (v) out[key] = v
  }
  text('note', MAX_NOTE)
  text('tag', 200)
  text('ticket', 200)
  text('pr', 2000)
  text('env', MAX_NOTE)
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
  if (incoming.env) data.env = incoming.env
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
    const left = await viaGit(() => gitService.leftBehind(worktree.path, repo.linkedDirs ?? [], MAX_MOVE_LISTED_PATHS, repo.path))
    return {
      branch,
      origin: await gitService.originUrl(repo.path),
      repoName: repo.name,
      dirty: (await gitService.worktreeDirty(worktree.path)) ?? worktree.dirty ?? false,
      loaded: worktree.loaded,
      sessions: info,
      reviewComments: worktree.review?.comments.length ?? 0,
      queuedPrompts: worktree.sessions.reduce((n, s) => n + s.queue.length, 0),
      prWatch: !!(Object.hasOwn(repo.branchData, branch) && repo.branchData[branch].prWatch),
      ...left
    }
  },

  /** Everything the target needs, from an unloaded worktree. Changes nothing. */
  'move.export': async (p, ctx): Promise<MoveExport & { fingerprint: string }> => {
    const { project, repo, worktree, branch } = await source(ctx, p)
    if (worktree.loaded) throw codedError('IN_USE', `${worktree.path} has running sessions; unload it first`)
    const { patch, headSha } = await dirtyPatch(worktree.path, repo)
    const size = Buffer.byteLength(patch)
    if (size > MAX_MOVE_PATCH_BYTES) {
      throw bad(`the uncommitted changes make a ${MB(size)} patch; a move carries at most ${MB(MAX_MOVE_PATCH_BYTES)}. Commit or remove the large files first`)
    }
    const { info, carried } = await hashedSessions(worktree)
    const sessions: MoveSession[] = []
    const notCarried = info.filter((s) => !s.carried).map((s) => `${s.title}: ${s.reason}`)
    for (const { session, size, sha256: historySha256 } of carried) {
      if (historySha256 === null) {
        notCarried.push(`${session.title}: its history could not be read`)
        continue
      }
      const out: MoveSession = { title: session.title, llm: session.llm, agentSessionId: session.agentSessionId!, historyBytes: size, historySha256 }
      const type = session.sessionTypeId ? project.settings.sessionTypes?.find((t) => t.id === session.sessionTypeId) : undefined
      if (type) out.sessionTypeName = type.name
      if (session.systemPrompt) out.systemPrompt = session.systemPrompt
      if (session.status === 'complete') out.complete = true
      sessions.push(out)
    }
    const data = Object.hasOwn(repo.branchData, branch) ? repo.branchData[branch] : undefined
    const out = { branch, head: headSha, patch, sessions, notCarried, branchData: exportBranchData(project, data), history: ctx.history?.branch(project.id, repo.id, branch) ?? [], serverName: ctx.store.config.name ?? '', fingerprint: fingerprint(headSha, patch, fingerprinted(carried)) }
    // The patch travels JSON-escaped, in this answer and again in move.receive's params: a text
    // file of quotes or control characters can grow several times over, past the 16 MiB frame.
    let framed = Buffer.byteLength(JSON.stringify(out))
    // The history is cosmetic: the oldest entries go before the move is refused.
    while (framed > MAX_MOVE_FRAME_JSON_BYTES && out.history.length > 0) {
      out.history = out.history.slice(Math.ceil(out.history.length / 2))
      framed = Buffer.byteLength(JSON.stringify(out))
    }
    if (framed > MAX_MOVE_FRAME_JSON_BYTES) {
      throw bad(`the uncommitted changes make a patch too big to move (${MB(framed)} as the connection carries it; at most ${MB(MAX_MOVE_FRAME_JSON_BYTES)}). Commit or remove the large files first`)
    }
    return out
  },

  /**
   * One chunk of a carried session's history, from `offset` (at most MAX_MOVE_CHUNK_BYTES, base64).
   * Only from an unloaded worktree, for one of its Claude sessions with a history.
   */
  'move.history': async (p, ctx): Promise<MoveHistoryChunk> => {
    const agentSessionId = requireString(p.agentSessionId, 'agentSessionId')
    if (!Number.isInteger(p.offset) || p.offset < 0) throw bad('offset must be a whole number of bytes')
    const { worktree } = await source(ctx, p)
    if (worktree.loaded) throw codedError('IN_USE', `${worktree.path} has running sessions; unload it first`)
    const session = worktree.sessions.find((s) => s.agentSessionId === agentSessionId)
    const history = session ? await historyOf(worktree, session) : null
    if (!history) throw codedError('NOT_FOUND', `No carried history ${agentSessionId} in ${worktree.path}`)
    if (history.size > MAX_MOVE_HISTORY_SESSION_BYTES) throw bad(`that history is over ${MB(MAX_MOVE_HISTORY_SESSION_BYTES)}`)
    if (p.offset > history.size) throw bad(`offset is past the history's ${history.size} bytes`)
    const length = Math.min(MAX_MOVE_CHUNK_BYTES, history.size - p.offset)
    const buffer = Buffer.alloc(length)
    const handle = await open(history.file, 'r')
    try {
      const { bytesRead } = await handle.read(buffer, 0, length, p.offset)
      const offset = p.offset as number
      return { data: buffer.subarray(0, bytesRead).toString('base64'), offset, total: history.size, done: offset + bytesRead >= history.size }
    } finally {
      await handle.close()
    }
  },

  /** Target: opens a transfer for one move's histories into this project's repository. */
  'move.begin': async (p, ctx): Promise<{ transferId: string }> => {
    const project = ctx.projects.require(p.projectId)
    const repo = repoIn(project, p.repoId)
    findRegistered(ctx.store.config.repos, repo.path)
    return { transferId: await moveTransfers.begin(project.id, repo.id) }
  },

  /** Target: appends one chunk of a history to the transfer, in order (`offset` is what is staged so far). */
  'move.upload': async (p): Promise<{ size: number }> => ({ size: await moveTransfers.append(p.transferId, p.agentSessionId, p.offset, p.data) }),

  /** Target: drops a transfer and its files; an unknown or finished one is fine. */
  'move.abort': async (p): Promise<null> => {
    await moveTransfers.abort(p.transferId)
    return null
  },

  /**
   * The last step, once the target has the worktree: the source's copy is removed (force) only if
   * its HEAD and uncommitted work are what was exported; otherwise CONFLICT and nothing changes.
   * Its PR watch ends (the target watches it now). `verifyOnly`: the same checks, nothing removed
   * (the app asks before it tears the source's VM and dev stack down, the point of commitment).
   */
  'move.finish': async (p, ctx): Promise<null> => {
    const expected = requireString(p.fingerprint, 'fingerprint')
    if (!FINGERPRINT.test(expected)) throw bad('fingerprint must be what move.export returned')
    if (p.verifyOnly !== undefined && typeof p.verifyOnly !== 'boolean') throw bad('verifyOnly must be a boolean')
    const toServer = optionalServerName(p.toServer, 'toServer')
    const { repo, worktree, branch } = await source(ctx, p)
    if (worktree.loaded) throw codedError('IN_USE', `${worktree.path} was loaded again after it was copied; it is kept`)
    const unblock = ctx.sessions.blockPath(worktree.path)
    try {
      // A patch that can no longer be built (too big, not UTF-8 now) is a change since the export too.
      const { patch, headSha } = await dirtyPatch(worktree.path, repo).catch((err: Error) => {
        throw codedError('CONFLICT', `${worktree.path} changed after it was copied (${err.message}); it is kept`)
      })
      if (fingerprint(headSha, patch, fingerprinted((await hashedSessions(worktree)).carried)) !== expected) {
        throw codedError('CONFLICT', `${worktree.path} changed after it was copied; it is kept`)
      }
      if (p.verifyOnly === true) return null
      await viaGit(() => gitService.removeWorktreeForce(repo.path, worktree.path, repo.linkedDirs ?? []))
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
    recordHistory(ctx, requireString(p.projectId, 'projectId'), repo.id, branch, [{ kind: 'moved.out', ...(toServer ? { to: { text: toServer } } : {}) }])
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
        const invalid = await checkBranchName(repo.path, branch, false).then(() => undefined, (err: Error) => err.message)
        const blocked = invalid ?? (await blockedReason(ctx, repo, branch, path))
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
    assertNotPromoting(repo.path)
    const branch = requireBranch(p.branch)
    await checkBranchName(repo.path, branch, false)
    const head = requireString(p.head, 'head')
    if (!SHA.test(head)) throw bad('head must be a full commit id')
    if (p.patch !== undefined && typeof p.patch !== 'string') throw bad('patch must be a string')
    const patch: string = p.patch ?? ''
    if (Buffer.byteLength(patch) > MAX_MOVE_PATCH_BYTES) throw bad(`patch must be at most ${MB(MAX_MOVE_PATCH_BYTES)}`)
    const sessions = checkSessions(p.sessions)
    const incoming = checkBranchData(p.branchData)
    const carried = checkHistory(p.history)
    const fromServer = optionalServerName(p.fromServer, 'fromServer')
    await moveTransfers.sweep()
    // The transfer is the move's: whatever happens below, its staged files go.
    let staged: StagedHistories | undefined
    if (p.transferId !== undefined) staged = moveTransfers.take(p.transferId, project.id, repo.id)
    else if (sessions.length > 0) throw bad('transferId is needed to carry sessions')
    try {
      const received = await receive(ctx, p, project, repo, branch, head, patch, sessions, incoming, staged)
      const ids = ctx.history?.import(project.id, repo.id, branch, carried.events) ?? []
      recordHistory(ctx, project.id, repo.id, branch, [{ kind: 'moved.in', ...(fromServer ? { from: { text: fromServer } } : {}) }])
      const latest = ctx.history?.latest(project.id, repo.id, branch)
      const receipt = receipts.get(received.undoToken)
      if (receipt) receipt.historyIds = latest?.kind === 'moved.in' ? [...ids, latest.id] : ids
      const unread: string[] = []
      if (carried.unreadable > 0) unread.push(`${carried.unreadable} history ${carried.unreadable === 1 ? 'entry' : 'entries'} the target could not read`)
      if (carried.overCap > 0) unread.push(`${carried.overCap} oldest history ${carried.overCap === 1 ? 'entry' : 'entries'} left out (over the ${MAX_HISTORY_PER_BRANCH} kept)`)
      return { ...received, dropped: [...received.dropped, ...unread], serverName: ctx.store.config.name ?? '' }
    } finally {
      await staged?.discard()
    }
  },

  /**
   * Target: undoes one `move.receive` whole, by its `undoToken` (within MOVE_UNDO_MS, once): the
   * client's rollback when the source's `move.finish` refuses. Only while the new worktree is
   * unloaded (IN_USE) and unchanged since the receive (CONFLICT; then nothing changes). Removes
   * it (force) and its row, deletes the branch it created (or moves back the one it
   * fast-forwarded) if still at the moved head, puts the branch data back as it was (a PR watch
   * it started ends), and removes the history files and folder it created.
   */
  'move.unreceive': async (p, ctx): Promise<null> => {
    const project = ctx.projects.require(p.projectId)
    const repo = repoIn(project, p.repoId)
    const token = requireString(p.undoToken, 'undoToken')
    sweepReceipts()
    const receipt = receipts.get(token)
    if (!receipt || receipt.projectId !== project.id || receipt.repoId !== repo.id) {
      throw codedError('NOT_FOUND', 'No such receive to undo (it was undone already, is over an hour old, or this server restarted since)')
    }
    findRegistered(ctx.store.config.repos, repo.path)
    const row = repo.worktrees.find((w) => w.id === receipt.worktreeId)
    if (!row) throw codedError('NOT_FOUND', `${receipt.path} is no longer one of this repository's worktrees`)
    if (row.loaded) throw codedError('IN_USE', `${receipt.path} was loaded after the move; it is kept`)
    assertNotPromoting(repo.path)
    // The receive's own lock: an undo must never run beside a receive of the same branch.
    const key = `${real(repo.path)}\0${receipt.branch}`
    if (receiving.has(key)) throw codedError('CONFLICT', `another move is bringing ${receipt.branch} into ${repo.path} right now; try again once it is done`)
    receiving.add(key)
    try {
      await unreceive(ctx, project, repo, token, receipt, row)
      ctx.history?.remove(project.id, repo.id, receipt.branch, receipt.historyIds ?? [])
    } finally {
      receiving.delete(key)
    }
    return null
  }
}

/** move.unreceive's work, once it holds the branch's receive lock. */
async function unreceive(ctx: V2Context, project: Project, repo: Repository, token: string, receipt: Receipt, row: Worktree): Promise<void> {
  const g = (args: string[]): Promise<string> => gitService.git(repo.path, args)
  const unblock = ctx.sessions.blockPath(receipt.path)
  try {
    const now = await dirtyPatch(receipt.path, repo).then(
      ({ patch, headSha }) => (headSha === receipt.head ? gitService.patchDigest(patch) : null),
      () => null
    )
    if (now !== receipt.digest) throw codedError('CONFLICT', `${receipt.path} changed after the move; it is kept`)
    await viaGit(() => gitService.removeWorktreeForce(repo.path, receipt.path, repo.linkedDirs ?? []))
    receipts.delete(token)
  } finally {
    unblock()
  }
  const at = await g(['rev-parse', '--verify', '--quiet', `refs/heads/${receipt.branch}`]).then((s) => s.trim(), () => null)
  if (at === receipt.head) {
    if (receipt.createdBranch) await g(['branch', '-D', '--', receipt.branch]).catch(() => {})
    else if (receipt.movedFrom) await g(['update-ref', `refs/heads/${receipt.branch}`, receipt.movedFrom, receipt.head]).catch(() => {})
  }
  await ctx.poller.refresh(repo.path).catch(() => false)
  let endWatch = false
  ctx.projects.apply(project.id, (d) => {
    const r = repoIn(d, repo.id)
    r.worktrees = r.worktrees.filter((w) => w.id !== receipt.worktreeId)
    const orderKey = `${repo.id} ${row.path}`
    if (d.settings.worktreeOrder) {
      const order = d.settings.worktreeOrder.filter((k) => k !== orderKey)
      if (order.length > 0) d.settings.worktreeOrder = order
      else delete d.settings.worktreeOrder
    }
    const current = Object.hasOwn(r.branchData, receipt.branch) ? r.branchData[receipt.branch] : undefined
    endWatch = !!current?.prWatch && !(receipt.previous?.prWatch && receipt.previous.pr === current.pr)
    if (receipt.previous) r.branchData[receipt.branch] = structuredClone(receipt.previous)
    else delete r.branchData[receipt.branch]
  })
  if (endWatch) ctx.prWatch?.forget(project.id, repo.id, receipt.branch)
  for (const file of receipt.createdFiles) await rm(file, { force: true }).catch(() => {})
  if (receipt.createdDir) await rmdir(receipt.createdDir).catch(() => {})
  ctx.sessions.refreshAttention()
}

/**
 * git apply's refusal of a file under a symlink, said plainly: the source has a real folder (its
 * files carried) where this server links one of the repository's linkedDirs from its main
 * checkout. Null for any other apply error.
 */
function linkedApplyMessage(stderr: string, repo: Repository): string | null {
  const m = /affected file '([^']+)' is beyond a symbolic link/.exec(stderr)
  if (!m) return null
  const file = m[1]
  const dir = (repo.linkedDirs ?? []).map(gitService.normalizeLinkedDir).find((d) => d !== null && (file === d || file.startsWith(d + '/'))) ?? file.split('/')[0]
  return `the uncommitted work has ${file}, inside ${dir}, which the source has as a folder of its own but this server links from ${repo.path} (the repository's linked folders); nothing was moved. Commit or move out what is in ${dir} on the source, or remove ${dir} from ${repo.path} here, first`
}

/** move.receive's work, once its params are checked and its transfer taken. */
async function receive(
  ctx: V2Context,
  p: any,
  project: Project,
  repo: Repository,
  branch: string,
  head: string,
  patch: string,
  sessions: MoveSession[],
  incoming: MoveBranchData,
  staged: StagedHistories | undefined
): Promise<MoveReceived> {
  const records = project.globalSessions.length + project.repositories.reduce((n, r) => n + r.worktrees.reduce((m, w) => m + w.sessions.length, 0), 0)
  if (records + sessions.length > MAX_SESSIONS_PER_PROJECT) throw codedError('CAPACITY', `a project holds at most ${MAX_SESSIONS_PER_PROJECT} sessions`)

  const target = ctx.store.guard.check(defaultWorktreePath(repo.path, branch))
  assertNotRepository(ctx.store.config.repos, target, 'path')
  // One receive of a branch into a repository at a time: a second would race the first's
  // checks and could undo what the first built.
  const key = `${real(repo.path)}\0${branch}`
  if (receiving.has(key)) throw codedError('CONFLICT', `another move is bringing ${branch} into ${repo.path} right now`)
  receiving.add(key)
  try {
    return await build(ctx, p, project, repo, branch, head, patch, sessions, incoming, staged, target)
  } finally {
    receiving.delete(key)
  }
}

/** move.receive's building, once it holds the repository's branch. */
async function build(
  ctx: V2Context,
  p: any,
  project: Project,
  repo: Repository,
  branch: string,
  head: string,
  patch: string,
  sessions: MoveSession[],
  incoming: MoveBranchData,
  staged: StagedHistories | undefined,
  target: string
): Promise<MoveReceived> {
  const blocked = await blockedReason(ctx, repo, branch, target)
  if (blocked) throw codedError('CONFLICT', blocked)

  const undo: (() => Promise<unknown>)[] = []
  const g = (args: string[], options?: { timeout?: number }): Promise<string> => gitService.git(repo.path, args, options)
  let createdBranch = false
  let movedFrom: string | null = null
  let digest = ''
  const createdFiles: string[] = []
  let createdDir: string | null = null
  /** Run once the receive succeeded (dropping the backups of histories it replaced) */
  const later: (() => Promise<unknown>)[] = []
  try {
    await viaGit(() => g(['fetch', '--no-tags', 'origin', '--', `+refs/heads/${branch}:refs/remotes/origin/${branch}`], { timeout: MOVE_FETCH_TIMEOUT_MS }))
    const fetched = (await viaGit(() => g(['rev-parse', '--verify', `refs/remotes/origin/${branch}^{commit}`]))).trim()
    if (fetched !== head) throw codedError('CONFLICT', `origin's ${branch} is at ${fetched.slice(0, 8)}, not the source's ${head.slice(0, 8)}: did something else push to it?`)
    const local = await g(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).then((s) => s.trim(), () => null)
    if (local === null) {
      await viaGit(() => g(['branch', '--track', '--', branch, `refs/remotes/origin/${branch}`]))
      createdBranch = true
      undo.push(() => g(['branch', '-D', '--', branch]))
    } else if (local !== head) {
      const behind = await g(['merge-base', '--is-ancestor', local, head]).then(() => true, () => false)
      if (!behind) throw codedError('CONFLICT', `this server's own ${branch} has commits the source's doesn't; reconcile them first`)
      await viaGit(() => g(['update-ref', `refs/heads/${branch}`, head, local]))
      movedFrom = local
      undo.push(() => g(['update-ref', `refs/heads/${branch}`, local, head]))
    }
    const unblock = ctx.sessions.blockPath(target)
    try {
      await viaGit(() => gitService.addWorktreeAt(repo.path, target, branch))
      undo.push(() => gitService.removeWorktreeForce(repo.path, target, repo.linkedDirs ?? []))
      for (const warning of await gitService.linkDirs(repo.path, target, repo.linkedDirs ?? [])) console.warn(`linkedDirs in ${target}: ${warning}`)
      const checked = await viaGit(() => gitService.revParseHead(target))
      if (checked !== head) throw codedError('GIT_ERROR', `${target} checked out ${checked.slice(0, 8)}, not ${head.slice(0, 8)}`)
      if (patch !== '') await viaGit(() => gitService.applyPatch(target, patch).catch((err: Error) => {
        throw new Error(linkedApplyMessage(err.message, repo) ?? err.message)
      }))
      // The work as this server's git now sees it must be the source's, exactly: built the same
      // way, the same patch (hunk headers' function context aside).
      const applied = await dirtyPatch(target, repo)
      digest = gitService.patchDigest(applied.patch)
      if (digest !== gitService.patchDigest(patch)) {
        throw codedError(
          'GIT_ERROR',
          "the uncommitted work here does not match the source's after the apply (does this server's git config differ: core.autocrlf, an excludes file, a filter?); nothing was moved"
        )
      }
    } finally {
      unblock()
    }
    const dir = projectDir(target)
    if (sessions.length > 0 && !existsSync(dir)) {
      await mkdir(dir, { recursive: true })
      createdDir = dir
      undo.push(() => rmdir(dir))
    }
    for (const s of sessions) {
      const from = staged?.file(s.agentSessionId)
      if (!from || staged!.size(s.agentSessionId) !== s.historyBytes || (await sha256File(from)) !== s.historySha256) {
        throw bad(`the history of “${s.title}” did not arrive whole (${staged?.size(s.agentSessionId) ?? 0} of ${s.historyBytes} bytes, or another hash)`)
      }
      const file = join(dir, `${s.agentSessionId}.jsonl`)
      const backup = existsSync(file) ? `${file}.trek-move-${randomUUID()}` : null
      if (backup) await copyFile(file, backup)
      await mkdir(dir, { recursive: true })
      await copyFile(from, file)
      await chmod(file, 0o600)
      if (backup) {
        // Undone in reverse: the old file back, then its backup gone.
        undo.push(() => rm(backup, { force: true }))
        undo.push(() => copyFile(backup, file))
        later.push(() => rm(backup, { force: true }))
      } else {
        createdFiles.push(file)
        undo.push(() => rm(file, { force: true }))
      }
    }
    if (!(await ctx.poller.refresh(repo.path))) {
      throw codedError('GIT_ERROR', `could not re-read the worktrees: ${ctx.poller.warning(repo.path)?.message ?? 'unknown error'}`)
    }
    const dropped: string[] = []
    const watchable = ctx.prWatch?.available() ?? false
    let previous: BranchData | undefined
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
      previous = existing ? structuredClone(existing) : undefined
      const data = mergeBranchData(d, existing, incoming, watchable, dropped)
      if (Object.keys(data).length > 0) r.branchData[branch] = data
      return created.id
    })
    const watched = Object.hasOwn(repoIn(ctx.projects.require(p.projectId), repo.id).branchData, branch) &&
      !!repoIn(ctx.projects.require(p.projectId), repo.id).branchData[branch].prWatch
    if (watched) ctx.prWatch?.pollSoon(project.id, repo.id, branch)
    for (const step of later) await step().catch(() => {})
    sweepReceipts()
    const undoToken = randomUUID()
    receipts.set(undoToken, {
      projectId: project.id,
      repoId: repo.id,
      branch,
      worktreeId,
      path: target,
      head,
      digest,
      previous,
      createdBranch,
      movedFrom,
      createdFiles,
      createdDir,
      expires: Date.now() + MOVE_UNDO_MS
    })
    return { worktreeId, dropped, undoToken }
  } catch (err) {
    for (const step of undo.reverse()) await step().catch(() => {})
    await ctx.poller.refresh(repo.path).catch(() => false)
    throw err
  }
}
