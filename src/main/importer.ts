// The .trekproj importer (phase 4d). A file is split by server (importProjectFile); each piece
// goes to its server over main's own connection to it (serverLinks.ts, so no token leaves main):
// its repositories are registered first (server.addRepo), then the project is sent with
// `project.import`. The project is read back to find the sessions whose path the server moved
// (its realpath), whose agent history is copied there on Local. migrated.json records the pieces
// (restoreWindows reads it, so a window on the file comes back on its project), and recents
// follow. The file is only read.
import { randomUUID } from 'node:crypto'
import { constants, realpathSync } from 'node:fs'
import { access, copyFile, mkdir, readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { RegisteredServer } from '../shared/client/index.ts'
import type { RawProjectFile } from '../shared/migration'
import { importProjectFile, LOCAL_TARGET, type ImportedProject } from '../shared/model/importProject.ts'
import { projectTopic } from '../shared/model/topics.ts'
import type { Project } from '../shared/model/types'
import type { ServerConfig } from '../shared/types'
import { projectDir } from '../host/claudeSessionService'
import { addAppServer, adoptAppServerToken, getAppServer, getAppServerToken, savedAppServers, serverLink } from './appServers'
import { LOCAL_SERVER_DISABLED } from './localServer'
import { LOCAL_ENTRY_ID, LOCAL_ENTRY_NAME } from './localServerRules'
import { legacyTokenFor } from './servers'
import { fileKey, isFileKey, updateMigrated } from './migrated'
import { rewriteRecentsForImport } from './recents'
import {
  capPieces,
  declineKey,
  dropWorktree,
  movedSessions,
  profileKeyFor,
  OVER_CAP_REASON,
  recordImport,
  routePiece,
  runScope,
  withProfileKeys,
  worktreeInError,
  type MigratedLeft,
  type MigratedPiece,
  type MovedSessions
} from './importRules'

/** Local may still be starting (first launch): its supervisor's own wait, and then some. */
const LOCAL_WAIT_MS = 60_000
const REMOTE_WAIT_MS = 15_000
const IMPORT_TIMEOUT_MS = 30_000
const READ_BACK_MS = 10_000
/** At most this many worktrees are dropped from one piece before the import gives up on it */
const MAX_REFUSED_WORKTREES = 50

export interface ImportOptions {
  /** Only these targets: a retry of the pieces left by an earlier import */
  only?: readonly string[]
  /**
   * A piece's server has no entry: whether to add it. `tokenCarried` says whether the token
   * saved for it in this app (for that origin) comes along.
   */
  askAddServer(server: ServerConfig, tokenCarried: boolean): Promise<boolean>
  /**
   * Servers (declineKey: origin and path) the user declined to add, so each is asked once. The
   * first-launch prompt shares one across its files; otherwise each import has its own (runScope).
   */
  declined?: Set<string>
  /** Entries that could not be reached, with why, so each is waited for once (shared as `declined` is) */
  unreachable?: Map<string, string>
}

export interface ImportReport {
  path: string
  /** migrated.json's key: the file's realpath */
  key: string
  name: string
  pieces: MigratedPiece[]
  left: MigratedLeft[]
  warnings: string[]
  /** Saved sessions whose agent history was copied to the path the server runs them in */
  carried: number
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err))
const codeOf = (err: unknown): string | undefined => (err as { code?: unknown } | null)?.code as string | undefined

/** Reads and splits the file; throws when it is not a project file. */
async function readProjectFile(path: string): Promise<RawProjectFile> {
  const raw = JSON.parse(await readFile(path, 'utf8')) as RawProjectFile
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('This is not a Trek project file')
  // An older or hand-written file: its name from the file name, and no worktrees.
  if (!raw.name) raw.name = basename(path).replace(/\.trekproj$/, '')
  if (!Array.isArray(raw.worktrees) && !raw.repositories) raw.worktrees = []
  return raw
}

export async function importTrekproj(path: string, given: ImportOptions): Promise<ImportReport> {
  const options: ImportOptions = { ...given, ...runScope(given) }
  const key = fileKey(path)
  const raw = await readProjectFile(path)
  const { projects, warnings, servers: fileServers } = importProjectFile(raw, randomUUID)
  const report: ImportReport = { path, key, name: raw.name, pieces: [], left: [], warnings: [...warnings], carried: 0 }
  const globals = Array.isArray(raw.globalSessions) ? raw.globalSessions.length : 0
  if (globals > 0 && !projects.some((p) => p.target === LOCAL_TARGET)) {
    report.warnings.push(`The Global panel's ${globals} session(s) were not imported: they belong with this machine's repositories, and the file has none.`)
  }
  const attempted: string[] = []
  const labelOf = (piece: ImportedProject): string => (piece.target === LOCAL_TARGET ? LOCAL_ENTRY_NAME : (piece.serverName ?? `server ${piece.target}`))
  // A file with many servers imports the first MAX_REMOTE_PIECES of them; a retry takes the next.
  const { kept, over } = capPieces(projects.filter((p) => !options.only || options.only.includes(p.target)))
  for (const piece of kept) {
    attempted.push(piece.target)
    const label = labelOf(piece)
    try {
      report.pieces.push(await importPiece(piece, fileServers, options, report))
    } catch (err) {
      report.left.push({ target: piece.target, label, reason: errorText(err) })
    }
  }
  for (const piece of over) {
    attempted.push(piece.target)
    report.left.push({ target: piece.target, label: labelOf(piece), reason: OVER_CAP_REASON })
  }
  await updateMigrated((m) => recordImport(m, key, { attempted, pieces: report.pieces, left: report.left }))
  if (report.pieces.length > 0) {
    await rewriteRecentsForImport(isFileKey(key), report.pieces).catch((err) => report.warnings.push(`Recent projects were not updated: ${errorText(err)}`))
  }
  return report
}

async function importPiece(piece: ImportedProject, fileServers: ServerConfig[], options: ImportOptions, report: ImportReport): Promise<MigratedPiece> {
  const entry = await entryFor(piece, fileServers, options)
  const isLocal = entry.id === LOCAL_ENTRY_ID
  const failed = options.unreachable?.get(entry.id)
  if (failed) throw new Error(failed)
  let link: RegisteredServer
  try {
    link = await waitForLink(entry.id, entry.name, isLocal ? LOCAL_WAIT_MS : REMOTE_WAIT_MS)
  } catch (err) {
    options.unreachable?.set(entry.id, errorText(err))
    throw err
  }
  let project = await registerRepositories(link, piece.project, entry.name, report.warnings)
  if (isLocal) project = withProfileKeys(project, localProfileKeys(project, piece.sourcePaths))
  const { projectId, sent } = await sendImport(link, project, entry.name, report.warnings)
  try {
    const moved = movedSessions(sent, await readProject(link, projectId), piece.globalCwd)
    if (isLocal) report.carried += await carryHistories(moved, report.warnings)
    else for (const m of moved) report.warnings.push(remoteMoveWarning(m, entry.name))
  } catch (err) {
    report.warnings.push(`Could not read the imported project back from ${entry.name} (${errorText(err)}): sessions whose path changed may start fresh.`)
  }
  return { target: piece.target, serverEntryId: entry.id, projectId, name: piece.project.name, serverName: entry.name }
}

/** The app-server entry a piece goes to: Local, a saved entry (its v1 token carried over), or one the user adds. */
async function entryFor(piece: ImportedProject, fileServers: ServerConfig[], options: ImportOptions): Promise<{ id: string; name: string }> {
  const route = routePiece(piece.target, fileServers, savedAppServers())
  // The v1 token was saved under the file's id for the server (a renamed `local` included).
  const legacyId = piece.legacyServerId ?? piece.target
  switch (route.kind) {
    case 'local':
      if (LOCAL_SERVER_DISABLED) throw new Error('The Local server is turned off')
      return { id: LOCAL_ENTRY_ID, name: LOCAL_ENTRY_NAME }
    case 'unknown':
      throw new Error(`${route.label}: ${route.why}`)
    case 'entry': {
      const entry = getAppServer(route.entryId)
      if (!entry) throw new Error(`${route.name} was removed from your servers`)
      const token = await legacyTokenFor(legacyId, entry.url)
      if (token) await adoptAppServerToken(entry.id, entry.url, token)
      return { id: entry.id, name: entry.name }
    }
    case 'add': {
      const declined = declineKey(route.server)
      if (options.declined?.has(declined)) throw new Error(`${route.server.name} was not added to your servers`)
      const token = await legacyTokenFor(legacyId, route.server.url)
      if (!(await options.askAddServer(route.server, token !== null))) {
        options.declined?.add(declined)
        throw new Error(`${route.server.name} was not added to your servers`)
      }
      const added = await addAppServer(route.server.name, route.server.url, token)
      return { id: added.id, name: added.name }
    }
  }
}

/** Main's own connection to the entry, once connected. A missing or rejected token fails at once. */
async function waitForLink(id: string, name: string, timeoutMs: number): Promise<RegisteredServer> {
  const noToken = `${name} has no access token here: set it in Open on server…, then open the file again to import this part`
  if (id !== LOCAL_ENTRY_ID && !(await getAppServerToken(id))) throw new Error(noToken)
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const link = serverLink(id)
    const status = link?.connection.status
    if (link && status === 'connected') return link
    if (status === 'needs-auth') throw new Error(`${name} rejected its access token: set it in Open on server…, then open the file again to import this part`)
    if (status === 'incompatible') throw new Error(`${name} is incompatible with this Trek (${link?.connection.statusMessage || 'upgrade it'})`)
    if (Date.now() >= deadline) throw new Error(`Could not connect to ${name}${status ? ` (${status})` : ''}`)
    await new Promise((done) => setTimeout(done, 150))
  }
}

/**
 * Registers each repository on the server (a no-op when it is already there). One the server
 * refuses (PATH_DENIED: outside its roots; NOT_A_REPO) is left out with a warning.
 */
async function registerRepositories(link: RegisteredServer, project: Project, serverName: string, warnings: string[]): Promise<Project> {
  const kept: Project['repositories'] = []
  for (const repo of project.repositories) {
    try {
      await link.connection.request('server.addRepo', { path: repo.path, name: repo.name })
      kept.push(repo)
    } catch (err) {
      const code = codeOf(err)
      if (code !== 'PATH_DENIED' && code !== 'NOT_A_REPO') throw err
      const sessions = repo.worktrees.reduce((n, w) => n + w.sessions.length, 0)
      warnings.push(
        `Repository "${repo.name}" (${repo.path}) was not added on ${serverName} (${code}: ${errorText(err)}); its ${repo.worktrees.length} worktree(s) and ${sessions} session(s) were not imported.`
      )
    }
  }
  if (kept.length === 0) throw new Error(`None of its repositories could be added on ${serverName}`)
  return { ...project, repositories: kept }
}

/** Each Local repository whose file path is not its realpath keeps the file's path for its VM names. */
function localProfileKeys(project: Project, sourcePaths: Record<string, string>): Map<string, string> {
  const keys = new Map<string, string>()
  for (const repo of project.repositories) {
    const source = sourcePaths[repo.id]
    let real: string
    try {
      real = realpathSync(repo.path)
    } catch {
      continue
    }
    const key = source === undefined ? undefined : profileKeyFor(source, real)
    if (key) keys.set(repo.id, key)
  }
  return keys
}

/** `project.import`; a worktree the server refuses by path is left out (with a warning) and the import is sent again. */
async function sendImport(link: RegisteredServer, project: Project, serverName: string, warnings: string[]): Promise<{ projectId: string; sent: Project }> {
  let sent = project
  for (let refused = 0; ; refused++) {
    try {
      const { projectId } = await link.connection.request('project.import', { project: sent }, { timeoutMs: IMPORT_TIMEOUT_MS })
      return { projectId, sent }
    } catch (err) {
      const code = codeOf(err)
      const ref = (code === 'PATH_DENIED' || code === 'BAD_REQUEST') && refused < MAX_REFUSED_WORKTREES ? worktreeInError(sent, errorText(err)) : null
      if (!ref) throw err
      const dropped = dropWorktree(sent, ref)
      sent = dropped.project
      warnings.push(`Worktree ${dropped.path} was refused by ${serverName} (${errorText(err)}); it and its ${dropped.sessions} session(s) were not imported.`)
    }
  }
}

/** The project as the server stored it: one snapshot from main's mirror, then unsubscribed. */
function readProject(link: RegisteredServer, projectId: string): Promise<Project> {
  return new Promise((resolve, reject) => {
    let done = false
    let off: (() => void) | null = null
    let unsubscribed = false
    // Once only: a snapshot delivered during subscribe() settles before `off` is set, so both
    // finish's microtask and the check after subscribe() may reach here.
    const unsubscribe = (): void => {
      if (unsubscribed || !off) return
      unsubscribed = true
      off()
    }
    const finish = (settle: () => void): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      settle()
      queueMicrotask(unsubscribe)
    }
    const timer = setTimeout(() => finish(() => reject(new Error('timed out'))), READ_BACK_MS)
    off = link.mirror.subscribe(projectTopic(projectId), (update) => {
      if ('error' in update) finish(() => reject(update.error))
      else finish(() => resolve(structuredClone(update.snapshot as Project)))
    })
    if (done) unsubscribe()
  })
}

const exists = (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false
  )

/**
 * Claude files a session's history under its working directory (claudeSessionService). A session
 * the server now runs from another path (its realpath) would not find it, so its .jsonl is copied
 * there, never moved: the file window can still resume it. One already there is left alone.
 */
async function carryHistories(moved: readonly MovedSessions[], warnings: string[]): Promise<number> {
  let copied = 0
  for (const m of moved) {
    for (const id of m.agentSessionIds) {
      const from = join(projectDir(m.from), `${id}.jsonl`)
      const to = join(projectDir(m.to), `${id}.jsonl`)
      try {
        if ((await exists(to)) || !(await exists(from))) continue
        await mkdir(projectDir(m.to), { recursive: true })
        await copyFile(from, to, constants.COPYFILE_EXCL)
        copied++
      } catch (err) {
        warnings.push(`The history of a session in ${m.worktree} was not copied to ${m.to} (${errorText(err)}); it may start fresh.`)
      }
    }
  }
  return copied
}

function remoteMoveWarning(m: MovedSessions, serverName: string): string {
  return `${m.agentSessionIds.length} session(s) in ${m.worktree} were saved under ${m.from}, but ${serverName} runs them in ${m.to}: they may start fresh rather than resume.`
}
