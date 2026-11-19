// What a plugin's slots see of the window's project (plugins E3): its repositories with that
// plugin's settings, and their worktrees with the server's ids. Pure: PluginHost.tsx supplies the
// store's project and rows; scripts/pluginSlots.test.mjs runs it.
import type { PluginRepo, PluginWorktree } from '../../../shared/plugins/client.ts'
import type { PluginSettingValues } from '../../../shared/plugins/manifest.ts'
import { hostKey, type GitWorktreeInfo, type ProjectFile } from '../../../shared/types.ts'

const NONE: Readonly<PluginSettingValues> = Object.freeze({})

const ownValues = (map: Readonly<Record<string, PluginSettingValues>> | undefined, pluginId: string): PluginSettingValues | undefined =>
  map && Object.hasOwn(map, pluginId) ? map[pluginId] : undefined

/** A row of the window as a plugin's worktree; `worktreeId` maps its path to the server's id. */
export function pluginWorktreeOf(info: GitWorktreeInfo, worktreeId: (path: string) => string | undefined): PluginWorktree {
  return {
    id: worktreeId(info.path) ?? '',
    repoId: info.repoId ?? '',
    path: info.path,
    ...(info.branch ? { branch: info.branch } : {}),
    isMain: info.isMain,
    missing: info.prunable === true
  }
}

/** The project's repositories as one plugin sees them; none without a project. */
export function pluginReposOf(
  project: ProjectFile | null,
  hostWorktrees: Readonly<Record<string, GitWorktreeInfo[]>>,
  pluginId: string,
  worktreeId: (path: string) => string | undefined
): PluginRepo[] {
  if (!project) return []
  return project.repositories.map((repo) => {
    const branchSettings: Record<string, PluginSettingValues> = {}
    for (const [branch, byPlugin] of Object.entries(repo.branchPluginSettings ?? {})) {
      const values = ownValues(byPlugin, pluginId)
      if (values) branchSettings[branch] = values
    }
    return {
      id: repo.id,
      name: repo.name,
      path: repo.path,
      settings: ownValues(repo.pluginSettings, pluginId) ?? NONE,
      branchSettings,
      worktrees: (hostWorktrees[`${repo.id} ${hostKey()}`] ?? []).map((info) => pluginWorktreeOf(info, worktreeId))
    }
  })
}

export interface ReposSource {
  project: ProjectFile | null
  hostWorktrees: Readonly<Record<string, GitWorktreeInfo[]>>
  /** The window's backend: another one maps the paths to other ids */
  backend: unknown
}

/**
 * pluginReposOf per plugin, made again only when the project, the rows or the backend change: the
 * same array otherwise, so useSyncExternalStore can hand it to React as a stable snapshot.
 */
export function cachedRepos(read: () => ReposSource, worktreeId: (path: string) => string | undefined): (pluginId: string) => readonly PluginRepo[] {
  const cache = new Map<string, ReposSource & { repos: PluginRepo[] }>()
  return (pluginId) => {
    const now = read()
    const hit = cache.get(pluginId)
    if (hit && hit.project === now.project && hit.hostWorktrees === now.hostWorktrees && hit.backend === now.backend) return hit.repos
    const repos = pluginReposOf(now.project, now.hostWorktrees, pluginId, worktreeId)
    cache.set(pluginId, { ...now, repos })
    return repos
  }
}
