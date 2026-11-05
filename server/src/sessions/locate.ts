// Finding sessions and worktrees inside a project (a stored one or an apply() draft).
import type { Project, Repository, Session, Worktree } from '../../../src/shared/model/types'
import { codedError } from '../errors.ts'
import { requireString } from '../validate.ts'

export interface FoundSession {
  session: Session
  /** Unset for a Global panel session */
  worktree?: Worktree
  repo?: Repository
}

export function findSession(project: Project, sessionId: unknown): FoundSession {
  const id = requireString(sessionId, 'sessionId')
  const global = project.globalSessions.find((s) => s.id === id)
  if (global) return { session: global }
  for (const repo of project.repositories) {
    for (const worktree of repo.worktrees) {
      const session = worktree.sessions.find((s) => s.id === id)
      if (session) return { session, worktree, repo }
    }
  }
  throw codedError('NOT_FOUND', `No session with id "${id}" in this project`)
}

export function findWorktree(project: Project, worktreeId: unknown): { repo: Repository; worktree: Worktree } {
  const id = requireString(worktreeId, 'worktreeId')
  for (const repo of project.repositories) {
    const worktree = repo.worktrees.find((w) => w.id === id)
    if (worktree) return { repo, worktree }
  }
  throw codedError('NOT_FOUND', `No worktree with id "${id}" in this project`)
}

/** The list a session lives in, for removing it. */
export function sessionList(project: Project, found: FoundSession): Session[] {
  return found.worktree ? found.worktree.sessions : project.globalSessions
}
