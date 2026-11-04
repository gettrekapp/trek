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
import type { BranchData, Project, ProjectSettings, Repository, Session, Worktree } from './types.ts'

/** Target for everything that lived on the machine that saved the file. */
export const LOCAL_TARGET = 'local'

export interface ImportedProject {
  /** LOCAL_TARGET, or the server id the file used */
  target: string
  /** The server's display name from the file, when it lists the server */
  serverName?: string
  project: Project
}

export interface ImportResult {
  projects: ImportedProject[]
  /** Human-readable notes about anything that could not be imported */
  warnings: string[]
}

function toSession(t: PersistedTerminal | GlobalSession): Session {
  const session: Session = {
    id: t.sessionId,
    agentSessionId: t.sessionId,
    title: t.title,
    llm: t.llm ?? { provider: 'claude' },
    queue: 'queue' in t && t.queue ? [...t.queue] : [],
    status: 'idle'
  }
  if ('sessionTypeId' in t && t.sessionTypeId) session.sessionTypeId = t.sessionTypeId
  if ('systemPrompt' in t && t.systemPrompt) session.systemPrompt = t.systemPrompt
  if ('ptyId' in t && t.ptyId) session.ptyId = t.ptyId
  return session
}

function toWorktree(w: WorktreeInstance, isMain: boolean): Worktree {
  const worktree: Worktree = {
    id: w.id,
    name: w.name,
    path: w.path,
    isMain,
    loaded: false,
    sessions: (w.terminals ?? []).map(toSession)
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
  warnings: string[]
): Repository | null {
  const isLocal = target === LOCAL_TARGET
  const path = isLocal ? r.path : r.serverPaths?.[target]
  const own = r.worktrees.filter((w) => (w.serverId ?? LOCAL_TARGET) === target)
  if (!path) {
    if (own.length > 0) {
      warnings.push(
        `Repository "${r.name}" has ${own.length} worktree(s) on ${label} but no clone path there; they were not imported.`
      )
    }
    return null
  }

  const savedMain = isLocal ? undefined : own.find((w) => w.path === path)
  const main: Worktree = savedMain
    ? toWorktree(savedMain, true)
    : {
        id: newId(),
        name: r.name,
        path,
        isMain: true,
        loaded: false,
        sessions: isLocal ? (r.primaryTerminals ?? []).map(toSession) : []
      }
  const others = own.filter((w) => w !== savedMain && w.path !== path).map((w) => toWorktree(w, false))

  const repo: Repository = {
    id: r.id,
    name: r.name,
    path,
    branchData: branchDataOf(r),
    worktrees: [main, ...others]
  }
  if (r.linkedDirs) repo.linkedDirs = [...r.linkedDirs]
  if (r.environments) repo.environments = r.environments
  return repo
}

function settingsOf(file: ProjectFile): ProjectSettings {
  const { version: _v, name: _n, repositories: _r, servers: _s, globalSessions: _g, ...settings } = file
  return settings
}

/** Keeps the target's `<hostKey> <path>` entries, as `<repoId> <path>`. */
function rekeyOrder(
  order: string[] | undefined,
  target: string,
  repositories: Repository[]
): string[] | undefined {
  if (!order) return undefined
  const repoByPath = new Map<string, string>()
  for (const repo of repositories) for (const w of repo.worktrees) repoByPath.set(w.path, repo.id)
  const prefix = `${target} `
  const out: string[] = []
  for (const key of order) {
    if (!key.startsWith(prefix)) continue
    const path = key.slice(prefix.length)
    const repoId = repoByPath.get(path)
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
    const repositories = file.repositories
      .map((r) => repositoryFor(r, target, label, newId, warnings))
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
        globalSessions: isLocal ? (file.globalSessions ?? []).map(toSession) : []
      }
    }
    if (serverName !== undefined) imported.serverName = serverName
    projects.push(imported)
  }
  return { projects, warnings }
}

/** Any version of a project file, as read from disk → per-server projects. */
export function importProjectFile(raw: RawProjectFile, newId: () => string): ImportResult {
  return splitProjectByServer(migrateToV3(raw, newId), newId)
}
