// Turns a .trekproj into one v2 Project per machine it touched, for
// `project.import`. A project file could mix local and remote worktrees; in v2
// a project lives on exactly one server, so a mixed file splits in two or more.
// Pure: no Node, Electron or DOM imports.
import { migrateToV3, type RawProjectFile } from '../migration.ts'
import type {
  GlobalSession,
  PersistedTerminal,
  ProjectFile,
  Repository as FileRepository,
  WorktreeInstance
} from '../types.ts'
import { worktreeOrderKey } from './keys.ts'
import type {
  BranchData,
  Project,
  ProjectSettings,
  Repository,
  Session,
  Worktree
} from './types.ts'

/** Target for everything that lived on the machine that saved the file. */
export const LOCAL_TARGET = 'local'

export interface ImportedProject {
  /** LOCAL_TARGET, or the server id the file used */
  target: string
  /** The server's display name from the file, when it lists the server */
  serverName?: string
  project: Project
  /**
   * Each repository's path as the file had it, by repository id. `project` has it
   * normalized, and the server stores its realpath; the environment VM names of a
   * file window hashed this one (deriveProfileName).
   */
  sourcePaths: Record<string, string>
}

export interface ImportResult {
  projects: ImportedProject[]
  /** Human-readable notes about anything that could not be imported */
  warnings: string[]
}

/**
 * Strips trailing slashes (except on a bare "/") and collapses repeated ones.
 * Symlinked paths are not resolved here; the server reconciles them against
 * git on import.
 */
function normalizePath(p: string): string {
  const collapsed = p.replace(/\/{2,}/g, '/')
  return collapsed.length > 1 ? collapsed.replace(/\/+$/, '') : collapsed
}

// Session ids are fresh; the old id is kept as the agent session id. ptyId is
// not copied: an imported session is never running.
function toSession(t: PersistedTerminal | GlobalSession, newId: () => string): Session {
  const session: Session = {
    id: newId(),
    agentSessionId: t.sessionId,
    title: t.title,
    llm: t.llm ?? { provider: 'claude' },
    queue: 'queue' in t && t.queue ? [...t.queue] : [],
    status: 'idle'
  }
  if ('sessionTypeId' in t && t.sessionTypeId) session.sessionTypeId = t.sessionTypeId
  if ('systemPrompt' in t && t.systemPrompt) session.systemPrompt = t.systemPrompt
  return session
}

function toWorktree(w: WorktreeInstance, isMain: boolean, newId: () => string): Worktree {
  const worktree: Worktree = {
    id: newId(),
    name: w.name,
    path: w.path,
    isMain,
    loaded: false,
    sessions: (w.terminals ?? []).map((t) => toSession(t, newId))
  }
  if (w.branch) worktree.branch = w.branch
  return worktree
}

function branchDataOf(r: FileRepository): Record<string, BranchData> {
  const out: Record<string, BranchData> = {}
  const fold = <K extends keyof BranchData>(
    map: Record<string, NonNullable<BranchData[K]>> | undefined,
    key: K
  ): void => {
    for (const [branch, value] of Object.entries(map ?? {})) {
      ;(out[branch] ??= {})[key] = value
    }
  }
  fold(r.branchTags, 'tag')
  fold(r.branchCustomTags, 'customTags')
  fold(r.branchNotes, 'note')
  fold(r.branchTickets, 'ticket')
  fold(r.branchPullRequests, 'pr')
  fold(r.branchEnvVars, 'env')
  return out
}

function repositoryFor(
  r: FileRepository,
  target: string,
  label: string,
  newId: () => string,
  warnings: string[],
  sourcePaths: Record<string, string>
): Repository | null {
  const isLocal = target === LOCAL_TARGET
  const rawPath = isLocal ? r.path : r.serverPaths?.[target]
  const own = r.worktrees.filter((w) => (w.serverId ?? LOCAL_TARGET) === target)
  if (!rawPath) {
    if (own.length > 0) {
      const sessions = own.reduce((n, w) => n + (w.terminals?.length ?? 0), 0)
      warnings.push(
        `Repository "${r.name}" has ${own.length} worktree(s) (${sessions} session(s)) on ${label} but no clone path there; they were not imported.`
      )
    }
    return null
  }

  const path = normalizePath(rawPath)
  const atMain = own.filter((w) => normalizePath(w.path) === path)
  const savedMain = isLocal ? undefined : atMain[0]
  // Other saved worktrees at the main path fold their sessions into the main one.
  const extraSessions = atMain
    .filter((w) => w !== savedMain)
    .flatMap((w) => (w.terminals ?? []).map((t) => toSession(t, newId)))
  const main: Worktree = savedMain
    ? toWorktree(savedMain, true, newId)
    : {
        id: newId(),
        name: r.name,
        path,
        isMain: true,
        loaded: false,
        sessions: isLocal ? (r.primaryTerminals ?? []).map((t) => toSession(t, newId)) : []
      }
  main.sessions.push(...extraSessions)
  const others = own
    .filter((w) => normalizePath(w.path) !== path)
    .map((w) => toWorktree(w, false, newId))

  const repo: Repository = {
    id: newId(),
    name: r.name,
    path,
    branchData: branchDataOf(r),
    worktrees: [main, ...others]
  }
  if (r.linkedDirs) repo.linkedDirs = [...r.linkedDirs]
  if (r.environments) repo.environments = r.environments
  sourcePaths[repo.id] = rawPath
  return repo
}

function settingsOf(file: ProjectFile): ProjectSettings {
  const {
    version: _v,
    name: _n,
    repositories: _r,
    servers: _s,
    globalSessions: _g,
    // Legacy root keys a v3 file may still carry
    repositoryPath: _rp,
    worktrees: _w,
    globalSessionId: _gid,
    primaryTerminals: _pt,
    serverPaths: _sp,
    branchNotes: _bn,
    branchTags: _bt,
    branchCustomTags: _bc,
    branchTickets: _bk,
    branchPullRequests: _bp,
    branchEnvVars: _be,
    linkedDirs: _ld,
    environments: _env,
    ...settings
  } = file as unknown as Record<string, unknown>
  return settings as ProjectSettings
}

/** Keeps the target's `<hostKey> <path>` entries, as `<repoId> <path>`. */
function rekeyOrder(
  order: string[] | undefined,
  target: string,
  repositories: Repository[]
): string[] | undefined {
  if (!order) return undefined
  const repoByPath = new Map<string, string>()
  for (const repo of repositories)
    for (const w of repo.worktrees) repoByPath.set(normalizePath(w.path), repo.id)
  const prefix = `${target} `
  const out: string[] = []
  for (const key of order) {
    if (!key.startsWith(prefix)) continue
    const path = key.slice(prefix.length)
    const repoId = repoByPath.get(normalizePath(path))
    if (repoId) out.push(worktreeOrderKey(repoId, path))
  }
  return out
}

export function splitProjectByServer(file: ProjectFile, newId: () => string): ImportResult {
  const warnings: string[] = []
  const serverNames = new Map((file.servers ?? []).map((s) => [s.id, s.name]))

  const targets = new Set<string>([LOCAL_TARGET])
  for (const r of file.repositories) {
    for (const id of Object.keys(r.serverPaths ?? {})) targets.add(id)
    for (const w of r.worktrees) if (w.serverId) targets.add(w.serverId)
  }

  const settings = settingsOf(file)
  const projects: ImportedProject[] = []
  for (const target of targets) {
    const isLocal = target === LOCAL_TARGET
    const serverName = isLocal ? undefined : serverNames.get(target)
    const label = isLocal ? 'this machine' : (serverName ?? `server ${target}`)
    const sourcePaths: Record<string, string> = {}
    const repositories = file.repositories
      .map((r) => repositoryFor(r, target, label, newId, warnings, sourcePaths))
      .filter((r): r is Repository => r !== null)
    if (repositories.length === 0) continue

    const projectSettings: ProjectSettings = { ...settings }
    const order = rekeyOrder(file.worktreeOrder, target, repositories)
    if (order) projectSettings.worktreeOrder = order
    else delete projectSettings.worktreeOrder

    const imported: ImportedProject = {
      target,
      project: {
        id: newId(),
        name: file.name,
        settings: projectSettings,
        repositories,
        globalSessions: isLocal ? (file.globalSessions ?? []).map((t) => toSession(t, newId)) : []
      },
      sourcePaths
    }
    if (serverName !== undefined) imported.serverName = serverName
    projects.push(structuredClone(imported))
  }
  return { projects, warnings }
}

/** Any version of a project file, as read from disk → per-server projects. */
export function importProjectFile(raw: RawProjectFile, newId: () => string): ImportResult {
  return splitProjectByServer(migrateToV3(raw, newId), newId)
}
