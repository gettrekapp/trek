// The Settings page's tabs. Pure: SettingsPanel renders what this picks.

export interface SettingsTab {
  id: string
  label: string
}

/** A core tab's id, or a plugin's (`plugin:<id>`, plugins E3) */
export type SettingsTabId = string

export const SETTINGS_TABS: readonly SettingsTab[] = [
  { id: 'general', label: 'General' },
  { id: 'agents', label: 'Agents' },
  { id: 'sessions', label: 'Sessions' },
  { id: 'worktrees', label: 'Worktrees' },
  { id: 'plugins', label: 'Plugins' }
]

/** The tabs to show: the plugins' repository settings tabs (plugins E3) right before Plugins, Plugins where there is one to list. */
export function visibleSettingsTabs(has: { plugins: boolean; pluginTabs?: readonly SettingsTab[] }): SettingsTab[] {
  const core = SETTINGS_TABS.filter((t) => t.id !== 'plugins')
  return [...core, ...(has.pluginTabs ?? []), ...(has.plugins ? SETTINGS_TABS.filter((t) => t.id === 'plugins') : [])]
}

/** The tab on screen: the chosen one while it shows, General once it is gone. */
export function resolveSettingsTab(chosen: SettingsTabId, visible: readonly SettingsTab[]): SettingsTabId {
  return visible.some((t) => t.id === chosen) ? chosen : 'general'
}

/** The tab a key in the strip moves to; null where it moves nowhere (an end, or another key). */
export function nextSettingsTab(visible: readonly SettingsTab[], current: SettingsTabId, key: string): SettingsTabId | null {
  const at = visible.findIndex((t) => t.id === current)
  const to =
    key === 'ArrowRight' ? at + 1 : key === 'ArrowLeft' ? at - 1 : key === 'Home' ? 0 : key === 'End' ? visible.length - 1 : -1
  if (at < 0 || to === at) return null
  return visible[to]?.id ?? null
}
