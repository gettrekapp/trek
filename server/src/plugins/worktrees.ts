// A project's worktrees and repositories as a plugin sees them (plugins E1): host.worktree(s),
// host.repos and the worktree lifecycle's hooks. Read only: core keeps the model.
import type { Repository, Worktree } from '../../../src/shared/model/types'
import type { PluginRepo, PluginWorktree } from '../../../src/shared/plugins/server.ts'

export const pluginWorktree = (repo: Repository, worktree: Worktree): PluginWorktree => ({
  id: worktree.id,
  repoId: repo.id,
  repoPath: repo.path,
  path: worktree.path,
  branch: worktree.branch ?? null,
  present: worktree.missing !== true
})

export const pluginRepo = (repo: Repository): PluginRepo => ({ id: repo.id, path: repo.path, name: repo.name })
