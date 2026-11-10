// Pure helpers for building and inspecting v2 projects on the server.
import { sep } from 'node:path'
import type { Project, Repository, Session, Worktree } from '../../../src/shared/model/types'
import type { RemoteRepo } from '../../../src/shared/protocolV2'
import { codedError } from '../errors.ts'
import { realOrResolved as real } from '../repos.ts'
import { requireString } from '../validate.ts'

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
  const { ptyId: _p, exitCode: _e, decision: _d, ...rest } = s
  // `complete` is the user marking a session finished, not something that was running.
  return { ...rest, status: s.status === 'complete' ? 'complete' : 'idle' }
}

function resetWorktree(w: Worktree): Worktree {
  const { head: _h, dirty: _d, ahead: _a, behind: _b, missing: _m, prNotice: _n, ...rest } = w
  return { ...rest, loaded: false, sessions: w.sessions.map(resetSession) }
}

/** Nothing runs after a load or an import: statuses idle (except `complete`), worktrees unloaded, git state unknown. */
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

/** The project's repository with this id; BAD_REQUEST if not a string, NOT_FOUND if unknown. */
export function repoIn(project: Project, repoId: unknown): Repository {
  const id = requireString(repoId, 'repoId')
  const repo = project.repositories.find((r) => r.id === id)
  if (!repo) throw codedError('NOT_FOUND', `No repository with id "${id}" in this project`)
  return repo
}

/**
 * BAD_REQUEST if `path` (already resolved) is a registered repository or contains one:
 * a worktree there would let a project act on that repo. `shown` is the path as the client wrote it.
 */
export function assertNotRepository(registry: readonly RemoteRepo[], path: string, where: string, shown = path): void {
  const clash = registry.find((r) => {
    const repo = real(r.path)
    return repo === path || repo.startsWith(path.endsWith(sep) ? path : path + sep)
  })
  if (clash) throw codedError('BAD_REQUEST', `${where}: worktree path ${shown} is another repository (${clash.path}) or contains one`)
}
