// The Run menu's Env entry (plugins E3; WorktreeDetail's own before): shown where the repository has
// environments on and the worktree is on a branch, with the VM's dot once the poll knows it. Read
// while the window renders (no hooks); the slot's `subscribe` is the plugin store's.
import type { ClientPluginHost, PluginPanelEntry, PluginRepo, PluginRunDot, PluginWorktree } from '../../../src/shared/plugins/client.ts'
import type { EnvironmentInfo } from '../shared/types.ts'
import { envOn, repoKeyOf } from './settings.ts'
import { environmentFor, useColimaStore, type EnvBusyAction } from './store.ts'

/** The worktree's VM as the poll knows it, and the operation running on it. */
export function vmOf(
  repos: readonly PluginRepo[],
  worktree: PluginWorktree,
  environments: Record<string, EnvironmentInfo>,
  busy: Record<string, EnvBusyAction>
): { env?: EnvironmentInfo; busy?: EnvBusyAction } {
  const repo = repos.find((r) => r.id === worktree.repoId)
  const env = repo ? environmentFor(environments, repoKeyOf(repo), worktree.branch) : undefined
  return { ...(env ? { env } : {}), ...(env && busy[env.profile] ? { busy: busy[env.profile] } : {}) }
}

export function envPanelEntry(host: ClientPluginHost, worktree: PluginWorktree): PluginPanelEntry | null {
  const repos = host.repos()
  if (!envOn(repos.find((r) => r.id === worktree.repoId)) || !worktree.branch) return null
  const { environments, busy } = useColimaStore.getState()
  const vm = vmOf(repos, worktree, environments, busy)
  const dot: PluginRunDot | undefined = !vm.env ? undefined : vm.busy ? 'attention' : vm.env.vmState === 'running' ? 'running' : 'exited'
  return { label: 'Env', title: 'Isolated Docker environment for this worktree', ...(dot ? { dot } : {}) }
}
