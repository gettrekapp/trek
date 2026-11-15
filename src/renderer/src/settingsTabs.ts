// The Settings page's tabs. Pure: SettingsPanel renders what this picks.

export const SETTINGS_TABS = [
  { id: 'general', label: 'General' },
  { id: 'agents', label: 'Agents' },
  { id: 'sessions', label: 'Sessions' },
  { id: 'worktrees', label: 'Worktrees' },
  { id: 'environments', label: 'Environments' },
  { id: 'plugins', label: 'Plugins' }
] as const

export type SettingsTab = (typeof SETTINGS_TABS)[number]
export type SettingsTabId = SettingsTab['id']

/** The tabs to show: Environments where the server runs them, Plugins where there is one to list. */
export function visibleSettingsTabs(has: { environments: boolean; plugins: boolean }): SettingsTab[] {
  return SETTINGS_TABS.filter((t) => (t.id === 'environments' ? has.environments : t.id === 'plugins' ? has.plugins : true))
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
