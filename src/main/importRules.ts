// Importing a .trekproj (phase 4d): where each piece of a split file goes, what
// migrated.json records, and how recents and open-windows.json are rewritten. Pure.
import { LOCAL_ENTRY_ID, originOf } from '../shared/appServerRules.ts'
import { LOCAL_TARGET } from '../shared/model/importProject.ts'
import type { Project, Session } from '../shared/model/types.ts'
import { sessionMigrates } from '../shared/providers/selection.ts'
import type { ServerConfig } from '../shared/types.ts'
import { MAX_RECENTS, type RecentEntry } from './recentsRules.ts'
import { isTargetId, sameTarget, type OpenWindowEntry, type WindowTarget } from './windowRules.ts'

// ---- Where a piece goes -----------------------------------------------------------------------

/** Where one piece of a split file is sent. */
export type PieceRoute =
  /** What lived on the machine that saved the file: the Local server */
  | { kind: 'local' }
  /** A saved app-server entry on the legacy server's origin */
  | { kind: 'entry'; entryId: string; name: string }
  /** A server the file names that has no entry: the user is offered to add it */
  | { kind: 'add'; server: ServerConfig }
  /** Nowhere: `why` says so in the result */
  | { kind: 'unknown'; label: string; why: string }

function isWsUrl(url: string): boolean {
  try {
    const u = new URL(url.trim())
    return u.protocol === 'ws:' || u.protocol === 'wss:'
  } catch {
    return false
  }
}

const withoutTrailingSlash = (url: string): string => url.trim().replace(/\/+$/, '')

/**
 * The legacy server `target` (an id from the file's `servers`) matched to a saved entry by
 * origin (scheme, host and port). An entry with the very same URL wins over another on that
 * origin. The Local entry is never a match: it is this machine, whatever its port.
 */
export function routePiece(
  target: string,
  fileServers: readonly ServerConfig[],
  entries: readonly { id: string; name: string; url: string }[]
): PieceRoute {
  if (target === LOCAL_TARGET) return { kind: 'local' }
  const server = fileServers.find((s) => s.id === target)
  if (!server) return { kind: 'unknown', label: `server ${target}`, why: "the file's server list does not name it" }
  const origin = originOf(server.url)
  if (!origin || !isWsUrl(server.url)) return { kind: 'unknown', label: server.name, why: 'its address is not a ws:// or wss:// URL' }
  const same = entries.filter((e) => e.id !== LOCAL_ENTRY_ID && originOf(e.url) === origin)
  const hit = same.find((e) => withoutTrailingSlash(e.url) === withoutTrailingSlash(server.url)) ?? same[0]
  return hit ? { kind: 'entry', entryId: hit.id, name: hit.name } : { kind: 'add', server }
}

// ---- migrated.json ----------------------------------------------------------------------------

/** One piece that landed: the project it became, and the labels a recent entry shows. */
export interface MigratedPiece {
  /** LOCAL_TARGET, or the legacy server id from the file */
  target: string
  serverEntryId: string
  projectId: string
  name: string
  serverName: string
}

/** One piece that did not land, and why: opening the file again offers to retry it. */
export interface MigratedLeft {
  target: string
  label: string
  reason: string
}

export interface MigratedFile {
  pieces: MigratedPiece[]
  left: MigratedLeft[]
}

/** userData/migrated.json: by the realpath of each imported .trekproj. */
export interface Migrated {
  /** The first-launch prompt has run (whatever the answer) */
  prompted: boolean
  files: Record<string, MigratedFile>
}

const str = (v: unknown): v is string => typeof v === 'string'

function parsePiece(raw: unknown): MigratedPiece | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (!str(r.target) || !r.target || !isTargetId(r.serverEntryId) || !isTargetId(r.projectId) || !str(r.name) || !str(r.serverName)) return null
  return { target: r.target, serverEntryId: r.serverEntryId, projectId: r.projectId, name: r.name, serverName: r.serverName }
}

function parseLeft(raw: unknown): MigratedLeft | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  return str(r.target) && r.target && str(r.label) && str(r.reason) ? { target: r.target, label: r.label, reason: r.reason } : null
}

const kept = <T>(items: unknown, parse: (raw: unknown) => T | null): T[] =>
  Array.isArray(items) ? items.map(parse).filter((x): x is T => x !== null) : []

/** Tolerates anything on disk: a bad file entry is dropped, never the rest. */
export function parseMigrated(raw: unknown): Migrated {
  const out: Migrated = { prompted: false, files: Object.create(null) as Record<string, MigratedFile> }
  if (!raw || typeof raw !== 'object') return { ...out, files: {} }
  const r = raw as Record<string, unknown>
  out.prompted = r.prompted === true
  const files = r.files
  if (files && typeof files === 'object' && !Array.isArray(files)) {
    for (const [key, value] of Object.entries(files)) {
      if (!key || key === '__proto__' || !value || typeof value !== 'object') continue
      const v = value as Record<string, unknown>
      out.files[key] = { pieces: kept(v.pieces, parsePiece), left: kept(v.left, parseLeft) }
    }
  }
  return { prompted: out.prompted, files: { ...out.files } }
}

export function serializeMigrated(m: Migrated): unknown {
  return { prompted: m.prompted, files: m.files }
}

export function migratedFile(m: Migrated, key: string): MigratedFile | undefined {
  return Object.prototype.hasOwnProperty.call(m.files, key) ? m.files[key] : undefined
}

/**
 * One import of the file at `key`: the targets it tried, the pieces that landed (each
 * replacing an older piece of its target) and the ones left. Left pieces of targets it did
 * not try stay. Pieces are kept Local's first. A file with no piece at all is not recorded:
 * opening it imports it again.
 */
export function recordImport(
  m: Migrated,
  key: string,
  run: { attempted: readonly string[]; pieces: readonly MigratedPiece[]; left: readonly MigratedLeft[] }
): Migrated {
  const before = migratedFile(m, key) ?? { pieces: [], left: [] }
  const landed = new Set(run.pieces.map((p) => p.target))
  const tried = new Set(run.attempted)
  const pieces = localFirst([...before.pieces.filter((p) => !landed.has(p.target)), ...run.pieces])
  const left = [...before.left.filter((l) => !tried.has(l.target) && !landed.has(l.target)), ...run.left]
  const files = { ...m.files }
  if (pieces.length === 0) delete files[key]
  else files[key] = { pieces, left }
  return { ...m, files }
}

export function markPrompted(m: Migrated): Migrated {
  return { ...m, prompted: true }
}

export function localFirst<T extends { target: string }>(pieces: readonly T[]): T[] {
  return [...pieces.filter((p) => p.target === LOCAL_TARGET), ...pieces.filter((p) => p.target !== LOCAL_TARGET)]
}

// ---- Recents and open-windows.json ------------------------------------------------------------

export function recentOf(piece: MigratedPiece): Extract<RecentEntry, { kind: 'server' }> {
  return { kind: 'server', serverEntryId: piece.serverEntryId, projectId: piece.projectId, name: piece.name, serverName: piece.serverName }
}

export function targetOf(piece: MigratedPiece): Extract<WindowTarget, { kind: 'server' }> {
  return { kind: 'server', serverEntryId: piece.serverEntryId, projectId: piece.projectId }
}

const sameServerRecent = (a: RecentEntry, b: RecentEntry): boolean =>
  a.kind === 'server' && b.kind === 'server' && a.serverEntryId === b.serverEntryId && a.projectId === b.projectId

/**
 * The file's recent entries (`isFile` says which paths are it: the caller compares realpaths)
 * become one server entry per piece, Local's first, where the first of them stood; when the
 * file was not listed, they go first. A server entry already listed moves rather than doubling.
 */
export function rewriteRecents(list: readonly RecentEntry[], isFile: (path: string) => boolean, pieces: readonly MigratedPiece[]): RecentEntry[] {
  if (pieces.length === 0) return [...list]
  const added = localFirst(pieces).map(recentOf)
  const isOld = (e: RecentEntry): boolean => (e.kind === 'file' && isFile(e.path)) || added.some((n) => sameServerRecent(n, e))
  const at = list.findIndex((e) => e.kind === 'file' && isFile(e.path))
  const before = at === -1 ? 0 : list.slice(0, at).filter((e) => !isOld(e)).length
  const rest = list.filter((e) => !isOld(e))
  return [...rest.slice(0, before), ...added, ...rest.slice(before)].slice(0, MAX_RECENTS)
}

/**
 * A window restored on the file comes back on Local's piece (or the first piece when the
 * file had nothing local), with its bounds. A second window on the file, or one on a
 * target already listed, is dropped: a target is restored once.
 */
export function rewriteOpenWindows(entries: readonly OpenWindowEntry[], isFile: (path: string) => boolean, pieces: readonly MigratedPiece[]): OpenWindowEntry[] {
  const first = localFirst(pieces)[0]
  if (!first) return [...entries]
  const target = targetOf(first)
  let placed = entries.some((e) => sameTarget(e.target, target))
  const out: OpenWindowEntry[] = []
  for (const entry of entries) {
    if (entry.target.kind !== 'file' || !isFile(entry.target.path)) {
      out.push(entry)
      continue
    }
    if (placed) continue
    placed = true
    out.push(entry.bounds ? { target, bounds: entry.bounds } : { target })
  }
  return out
}

/**
 * The windows to restore, with each one on an imported file moved to the file's Local piece
 * (rewriteOpenWindows), so a .trekproj that was imported never comes back as a file window.
 * `key` is a path's realpath. The next write of open-windows.json keeps the rewrite.
 */
export function restoreEntries(entries: readonly OpenWindowEntry[], m: Migrated, key: (path: string) => string): OpenWindowEntry[] {
  let out = [...entries]
  const keys = new Set(entries.flatMap((e) => (e.target.kind === 'file' ? [key(e.target.path)] : [])))
  for (const k of keys) {
    const file = migratedFile(m, k)
    if (file) out = rewriteOpenWindows(out, (path) => key(path) === k, file.pieces)
  }
  return out
}

/**
 * The files the first-launch prompt offers: those of the windows restored last time, then
 * the recents, once per file (`key` is its realpath), leaving out the ones already imported.
 * Whether each is still on disk is the caller's to check.
 */
export function promptCandidates(
  recents: readonly RecentEntry[],
  windows: readonly OpenWindowEntry[],
  m: Migrated,
  key: (path: string) => string
): { path: string; key: string }[] {
  const out: { path: string; key: string }[] = []
  const seen = new Set<string>()
  const paths = [
    ...windows.flatMap((w) => (w.target.kind === 'file' ? [w.target.path] : [])),
    ...recents.flatMap((e) => (e.kind === 'file' ? [e.path] : []))
  ]
  for (const path of paths) {
    const k = key(path)
    if (seen.has(k) || migratedFile(m, k)) continue
    seen.add(k)
    out.push({ path, key: k })
  }
  return out
}

// ---- Paths: the env profile key, sessions whose cwd moved, a worktree the server refused ------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** A Claude-style session id. Its .jsonl is copied by this name, so nothing else may pass. */
export function isAgentSessionId(id: unknown): id is string {
  return typeof id === 'string' && UUID.test(id)
}

/**
 * The repository path a Local repository's VM names keep hashing (EnvironmentSettings.profileKey):
 * the path as the file had it, when the server stores another (its realpath, without a
 * trailing slash). Undefined when they are the same string.
 */
export function profileKeyFor(filePath: string, serverPath: string): string | undefined {
  return filePath === serverPath ? undefined : filePath
}

/**
 * `project` with `keys` (repository id → profile key) on each repository's environments.
 * A repository without environments has made no VM, so it gets none; one that has a key keeps it.
 */
export function withProfileKeys(project: Project, keys: ReadonlyMap<string, string>): Project {
  return {
    ...project,
    repositories: project.repositories.map((repo) => {
      const key = keys.get(repo.id)
      if (!key || !repo.environments || repo.environments.profileKey) return repo
      return { ...repo, environments: { ...repo.environments, profileKey: key } }
    })
  }
}

/** Saved sessions whose working directory the server moved: their agent history is filed under `from`. */
export interface MovedSessions {
  /** The worktree's name, or "Global" */
  worktree: string
  from: string
  to: string
  agentSessionIds: string[]
}

/** Sessions whose history follows the cwd (Claude's kind: sessionMigration), with a usable id. */
function resumable(sessions: readonly Session[]): string[] {
  return sessions.filter((s) => sessionMigrates(s) && isAgentSessionId(s.agentSessionId)).map((s) => s.agentSessionId as string)
}

/**
 * Compares the project as sent with the project as the server stored it (ids are kept):
 * each worktree whose path changed, with its resumable sessions. Global sessions run in
 * the first repository's main worktree.
 */
export function movedSessions(sent: Project, stored: Project): MovedSessions[] {
  const out: MovedSessions[] = []
  const storedPaths = new Map<string, string>()
  for (const repo of stored.repositories) for (const w of repo.worktrees) storedPaths.set(w.id, w.path)
  for (const repo of sent.repositories) {
    for (const w of repo.worktrees) {
      const to = storedPaths.get(w.id)
      const ids = resumable(w.sessions)
      if (to !== undefined && to !== w.path && ids.length > 0) out.push({ worktree: w.name, from: w.path, to, agentSessionIds: ids })
    }
  }
  const firstMain = sent.repositories[0]?.worktrees.find((w) => w.isMain)
  const globalTo = firstMain ? storedPaths.get(firstMain.id) : undefined
  const globalIds = resumable(sent.globalSessions)
  if (firstMain && globalTo !== undefined && globalTo !== firstMain.path && globalIds.length > 0) {
    out.push({ worktree: 'Global', from: firstMain.path, to: globalTo, agentSessionIds: globalIds })
  }
  return out
}

export interface WorktreeRef {
  repoId: string
  worktreeId: string
}

/** Whether `message` names `path` as a whole: followed by its end, a space, a comma or a bracket. */
function names(message: string, path: string): boolean {
  for (let at = message.indexOf(path); at !== -1; at = message.indexOf(path, at + 1)) {
    const next = message[at + path.length]
    if (next === undefined || next === ' ' || next === ',' || next === ')' || next === ';') return true
  }
  return false
}

/**
 * The non-main worktree a `project.import` refusal names (PATH_DENIED: "Path not under a
 * configured root: <path>"; BAD_REQUEST: "worktree path <path> is another repository"), so
 * the import can go on without it. The longest matching path wins. Null when none is named.
 */
export function worktreeInError(project: Project, message: string): WorktreeRef | null {
  let best: (WorktreeRef & { length: number }) | null = null
  for (const repo of project.repositories) {
    for (const w of repo.worktrees) {
      if (w.isMain || !names(message, w.path)) continue
      if (!best || w.path.length > best.length) best = { repoId: repo.id, worktreeId: w.id, length: w.path.length }
    }
  }
  return best ? { repoId: best.repoId, worktreeId: best.worktreeId } : null
}

/** `project` without the worktree; its path and how many saved sessions went with it. */
export function dropWorktree(project: Project, ref: WorktreeRef): { project: Project; path: string; sessions: number } {
  let path = ''
  let sessions = 0
  const repositories = project.repositories.map((repo) => {
    if (repo.id !== ref.repoId) return repo
    const gone = repo.worktrees.find((w) => w.id === ref.worktreeId)
    if (gone) {
      path = gone.path
      sessions = gone.sessions.length
    }
    return { ...repo, worktrees: repo.worktrees.filter((w) => w.id !== ref.worktreeId) }
  })
  return { project: { ...project, repositories }, path, sessions }
}
