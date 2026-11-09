// Validates a `project.import` payload (one project from importProjectFile())
// and returns it ready to store: the server's project id, nested ids kept,
// repository and main worktree paths taken from the registry, other worktree
// paths realpath'd, runtime state reset.
import type { Project, Repository, Session, Worktree } from '../../../src/shared/model/types'
import type { RemoteRepo } from '../../../src/shared/protocolV2'
import { codedError } from '../errors.ts'
import type { PathGuard } from '../paths.ts'
import { checkQueue, checkTitle } from '../sessions/limits.ts'
import { realOrResolved } from '../repos.ts'
import { assertNoProtoKeys, isRecord, requireAbsolutePath, requireName } from '../validate.ts'
import { assertNotRepository, findRegistered, resetRuntime } from './model.ts'
import { validateSettings } from './settings.ts'

export interface ImportContext {
  registry: readonly RemoteRepo[]
  guard: PathGuard
  /** Every id already used on this server */
  existingIds: ReadonlySet<string>
  /** The id the server assigns to the imported project */
  projectId: string
}

const bad = (message: string): Error => codedError('BAD_REQUEST', message)

function checkId(value: unknown, where: string, seen: Set<string>, existing: ReadonlySet<string>): string {
  if (typeof value !== 'string' || value === '' || value.includes(' ')) throw bad(`${where}.id must be a non-empty string without spaces`)
  if (seen.has(value)) throw bad(`${where}.id "${value}" is used twice in this project`)
  if (existing.has(value)) throw bad(`${where}.id "${value}" already exists on this server`)
  seen.add(value)
  return value
}

function checkSession(raw: unknown, where: string, seen: Set<string>, existing: ReadonlySet<string>): Session {
  if (!isRecord(raw)) throw bad(`${where} must be an object`)
  checkId(raw.id, where, seen, existing)
  if (typeof raw.title !== 'string') throw bad(`${where}.title must be a string`)
  checkTitle(raw.title, `${where}.title`)
  if (!isRecord(raw.llm) || typeof raw.llm.provider !== 'string') throw bad(`${where}.llm must name a provider`)
  // The limits session.setQueue applies.
  checkQueue(raw.queue, `${where}.queue`)
  for (const key of ['agentSessionId', 'sessionTypeId', 'systemPrompt']) {
    if (raw[key] !== undefined && typeof raw[key] !== 'string') throw bad(`${where}.${key} must be a string`)
  }
  return raw as unknown as Session
}

function checkWorktree(raw: unknown, where: string, ctx: ImportContext, seen: Set<string>, registered: RemoteRepo): Worktree {
  if (!isRecord(raw)) throw bad(`${where} must be an object`)
  checkId(raw.id, where, seen, ctx.existingIds)
  if (typeof raw.name !== 'string') throw bad(`${where}.name must be a string`)
  if (typeof raw.path !== 'string') throw bad(`${where}.path must be a string`)
  if (typeof raw.isMain !== 'boolean') throw bad(`${where}.isMain must be a boolean`)
  let path = registered.path
  if (!raw.isMain) {
    path = ctx.guard.check(requireAbsolutePath(raw.path, `${where}.path`))
    // A worktree at (or above) a registered repo would let the project act on that repo.
    assertNotRepository(ctx.registry, path, where, raw.path)
  }
  if (raw.branch !== undefined) {
    if (typeof raw.branch !== 'string') throw bad(`${where}.branch must be a string`)
    // The branch goes on git command lines (pull, push); the handlers check the full ref format.
    if (raw.branch.startsWith('-')) throw bad(`${where}.branch must not start with "-"`)
    if (/[\s\x00-\x1f\x7f]/.test(raw.branch)) throw bad(`${where}.branch must not contain whitespace or control characters`)
  }
  if (!Array.isArray(raw.sessions)) throw bad(`${where}.sessions must be an array`)
  raw.sessions.forEach((s, i) => checkSession(s, `${where}.sessions[${i}]`, seen, ctx.existingIds))
  return { ...(raw as unknown as Worktree), path }
}

function checkRepository(raw: unknown, where: string, ctx: ImportContext, seen: Set<string>, used: Set<string>): Repository {
  if (!isRecord(raw)) throw bad(`${where} must be an object`)
  checkId(raw.id, where, seen, ctx.existingIds)
  if (typeof raw.name !== 'string') throw bad(`${where}.name must be a string`)
  if (typeof raw.path !== 'string') throw bad(`${where}.path must be a string`)
  const registered = findRegistered(ctx.registry, raw.path)
  if (used.has(registered.id)) throw bad(`${where}: repository ${registered.path} is in this project twice`)
  used.add(registered.id)
  if (!isRecord(raw.branchData)) throw bad(`${where}.branchData must be an object`)
  for (const [branch, data] of Object.entries(raw.branchData)) {
    if (!isRecord(data)) throw bad(`${where}.branchData["${branch}"] must be an object`)
  }
  if (raw.linkedDirs !== undefined && (!Array.isArray(raw.linkedDirs) || raw.linkedDirs.some((d) => typeof d !== 'string'))) {
    throw bad(`${where}.linkedDirs must be an array of strings`)
  }
  if (raw.environments !== undefined && !isRecord(raw.environments)) throw bad(`${where}.environments must be an object`)
  if (!Array.isArray(raw.worktrees)) throw bad(`${where}.worktrees must be an array`)
  const worktrees = raw.worktrees.map((w, i) => checkWorktree(w, `${where}.worktrees[${i}]`, ctx, seen, registered))
  const mains = worktrees.filter((w) => w.isMain).length
  if (mains !== 1) throw bad(`${where}.worktrees must have exactly one isMain worktree (found ${mains})`)
  const paths = new Set<string>()
  worktrees.forEach((w, i) => {
    const key = realOrResolved(w.path)
    if (paths.has(key)) throw bad(`${where}.worktrees[${i}]: path ${w.path} is listed twice`)
    paths.add(key)
  })
  return { ...(raw as unknown as Repository), path: registered.path, worktrees }
}

export function checkImport(raw: unknown, ctx: ImportContext): Project {
  if (!isRecord(raw)) throw bad('project must be an object')
  assertNoProtoKeys(raw, 'project')
  const name = requireName(raw.name, 'project.name')
  const settings = validateSettings(raw.settings ?? {}, 'project.settings')
  if (!Array.isArray(raw.repositories) || raw.repositories.length === 0) throw bad('project.repositories must be a non-empty array')
  if (!Array.isArray(raw.globalSessions)) throw bad('project.globalSessions must be an array')
  const seen = new Set<string>([ctx.projectId])
  const used = new Set<string>()
  const repositories = raw.repositories.map((r, i) => checkRepository(r, `project.repositories[${i}]`, ctx, seen, used))
  const globalSessions = raw.globalSessions.map((s, i) => checkSession(s, `project.globalSessions[${i}]`, seen, ctx.existingIds))
  return resetRuntime(structuredClone({ id: ctx.projectId, name, settings, repositories, globalSessions }))
}
