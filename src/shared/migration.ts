// src/shared/migration.ts
// Runtime imports stay out of this file so `node --test` can load it directly.
import type { GlobalSession, ProjectFile, Repository, ServerConfig, WorktreeInstance } from './types'

type LegacyWorktree = WorktreeInstance & { ticketId?: string; pullRequestUrl?: string }

/** Any version of a project file, as read from disk. */
export type RawProjectFile = Omit<ProjectFile, 'version' | 'repositories' | 'servers'> &
  Partial<Omit<Repository, 'id' | 'name' | 'path' | 'worktrees' | 'serverPaths'>> & {
    version: number
    repositories?: Repository[]
    repositoryPath?: string
    worktrees?: LegacyWorktree[]
    servers?: (ServerConfig & { repoPath?: string })[]
    globalSessionId?: string
    globalSessions?: GlobalSession[]
  }

/** The last segment of a path, with either separator (a Windows path from an older file). */
function directoryName(path: string): string {
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? path
}

/**
 * Upgrades older project files on load:
 * - the main checkout used to be stored as a regular worktree; it is now the
 *   synthetic primary instance, so drop it from the list (local only — a
 *   remote worktree can legitimately share the local repo's path string).
 * - ticket/PR links used to live on the worktree instance; they are now keyed
 *   by branch so they survive promote/delete/re-create.
 * - v3 moves repository data into `repositories`, and each server's repoPath
 *   into Repository.serverPaths.
 */
export function migrateToV3(raw: RawProjectFile, newId: () => string): ProjectFile {
  if (raw.repositories !== undefined || raw.version >= 3) {
    if (!Array.isArray(raw.repositories)) {
      throw new Error('This project file is invalid: "repositories" must be a list.')
    }
    if (raw.repositories.length === 0) {
      throw new Error('This project file is invalid: it has no repositories.')
    }
    return {
      ...raw,
      repositories: raw.repositories.map((r) => ({ ...r, worktrees: r.worktrees ?? [] }))
    } as ProjectFile
  }

  const {
    repositoryPath = '',
    worktrees: legacyWorktrees = [],
    servers: legacyServers = [],
    globalSessionId,
    globalSessions,
    primaryTerminals,
    branchNotes,
    branchTags,
    branchCustomTags,
    branchTickets: legacyTickets,
    branchPullRequests: legacyPullRequests,
    branchEnvVars,
    linkedDirs,
    environments,
    ...shared
  } = raw

  const branchTickets = { ...(legacyTickets ?? {}) }
  const branchPullRequests = { ...(legacyPullRequests ?? {}) }
  const worktrees = legacyWorktrees
    .filter((w) => w.serverId || w.path !== repositoryPath)
    .map((w) => {
      const key = w.branch ?? w.name
      if (w.ticketId && !branchTickets[key]) branchTickets[key] = w.ticketId
      if (w.pullRequestUrl && !branchPullRequests[key]) branchPullRequests[key] = w.pullRequestUrl
      const { ticketId: _t, pullRequestUrl: _p, ...rest } = w
      return rest
    })

  const serverPaths: Record<string, string> = {}
  const servers = legacyServers.map(({ repoPath, ...server }) => {
    if (repoPath) serverPaths[server.id] = repoPath
    return server
  })

  const repository: Repository = {
    id: newId(),
    name: directoryName(repositoryPath),
    path: repositoryPath,
    ...(Object.keys(serverPaths).length > 0 ? { serverPaths } : {}),
    worktrees,
    primaryTerminals,
    branchNotes,
    branchTags,
    branchCustomTags,
    branchTickets,
    branchPullRequests,
    branchEnvVars,
    linkedDirs,
    environments
  }

  return {
    ...shared,
    version: 3,
    repositories: [repository],
    servers,
    globalSessions:
      globalSessions ?? (globalSessionId ? [{ sessionId: globalSessionId, title: 'Claude' }] : [])
  }
}
