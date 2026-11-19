// The env plugin's settings as its client reads and writes them (plugins E3): the repository's (its
// repoSettings: the old `environments`) and a branch's .env text (its branch setting `env`). Pure.
import type { PluginRepo } from '../../../src/shared/plugins/client.ts'
import type { PluginFieldValue, PluginSettingValues } from '../../../src/shared/plugins/manifest.ts'
import { repoKeyFor } from '../shared/environments.ts'

/** Whether the repository has environments on. */
export const envOn = (repo: Pick<PluginRepo, 'settings'> | undefined): boolean => repo?.settings.enabled === true

/** The path its VMs' names hash: the profileKey an import kept, else its own. */
export const repoKeyOf = (repo: Pick<PluginRepo, 'path' | 'settings'>): string => repoKeyFor(repo.path, repo.settings.profileKey)

/** The branch's .env text ('' when it has none). */
export function branchVars(repo: Pick<PluginRepo, 'branchSettings'> | undefined, branch: string): string {
  const text = repo && Object.hasOwn(repo.branchSettings, branch) ? repo.branchSettings[branch].env : undefined
  return typeof text === 'string' ? text : ''
}

/**
 * The branch's values with its .env text set to `text` (the Env panel's editor), its other keys
 * kept. An empty text stays as `env: ''`: the window's setter routes it (a .env held only in the
 * old field is cleared there) and drops it from the plugin's copy.
 */
export function withBranchVars(repo: Pick<PluginRepo, 'branchSettings'> | undefined, branch: string, text: string): PluginSettingValues {
  const current = repo && Object.hasOwn(repo.branchSettings, branch) ? repo.branchSettings[branch] : {}
  return { ...current, env: text }
}

/** The repository's values with `patch` over them; undefined in the patch removes that key. `enabled` is always there. */
export function patchedSettings(repo: Pick<PluginRepo, 'settings'>, patch: Readonly<Record<string, PluginFieldValue | undefined>>): PluginSettingValues {
  const out: PluginSettingValues = { enabled: false, ...repo.settings }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete out[key]
    else out[key] = value
  }
  return out
}
