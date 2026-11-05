// Pure helpers for building and inspecting v2 projects on the server.
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Project, Repository, Session, Worktree } from '../../../src/shared/model/types'
import type { RemoteRepo } from '../../../src/shared/protocol'
import { codedError } from '../errors.ts'

function real(path: string): string {
  try {
    return realpathSync(resolve(path))
  } catch {
    return resolve(path)
  }
}

/** The registered repo at `path` (compared by realpath), or PATH_DENIED. */
export function findRegistered(registry: readonly RemoteRepo[], path: string): RemoteRepo {
  const target = real(path)
  const match = registry.find((r) => real(r.path) === target)
  if (!match) {
    throw codedError('PATH_DENIED', `${path} is not a registered repo; run \`trek-server add ${path}\` on the server`)
  }
  return match
}

export function newRepository(registered: RemoteRepo, name: string | undefined, newId: () => string): Repository {
  const repoName = name ?? registered.name
  const main: Worktree = { id: '', name: repoName, path: registered.path, isMain: true, loaded: false, sessions: [] }
  const repo: Repository = { id: newId(), name: repoName, path: registered.path, branchData: {}, worktrees: [main] }
  main.id = newId()
  return repo
}

export function newProject(
  name: string,
  repositories: { registered: RemoteRepo; name: string | undefined }[],
  newId: () => string
): Project {
  const id = newId()
  return {
    id,
    name,
    settings: {},
    repositories: repositories.map((r) => newRepository(r.registered, r.name, newId)),
    globalSessions: []
  }
}

function resetSession(s: Session): Session {
  const { ptyId: _p, exitCode: _e, ...rest } = s
  return { ...rest, status: 'idle' }
}

function resetWorktree(w: Worktree): Worktree {
  const { head: _h, dirty: _d, ahead: _a, behind: _b, ...rest } = w
  return { ...rest, loaded: false, sessions: w.sessions.map(resetSession) }
}

/** Nothing runs after a load or an import: statuses idle, worktrees unloaded, git state unknown. */
export function resetRuntime(project: Project): Project {
  return {
    ...project,
    repositories: project.repositories.map((r) => ({ ...r, worktrees: r.worktrees.map(resetWorktree) })),
    globalSessions: project.globalSessions.map(resetSession)
  }
}

/** Names of the projects with a repository at `repoPath` (realpath-compared). */
export function projectsUsingRepo(projects: Iterable<Project>, repoPath: string): string[] {
  const target = real(repoPath)
  const names: string[] = []
  for (const p of projects) if (p.repositories.some((r) => real(r.path) === target)) names.push(p.name)
  return names
}

/** Every id in a project: its own, repositories, worktrees and sessions. */
export function collectIds(project: Project): Set<string> {
  const ids = new Set<string>([project.id])
  for (const s of project.globalSessions) ids.add(s.id)
  for (const r of project.repositories) {
    ids.add(r.id)
    for (const w of r.worktrees) {
      ids.add(w.id)
      for (const s of w.sessions) ids.add(s.id)
    }
  }
  return ids
}
