// The plugins' worktree slots in a project window (plugins E3): the Run menu's entries and their
// panels, the header chips, the sidebar badges, the hover card's rows and the Settings tabs. Each
// plugin component in its host and error boundary (PluginScope); the rules are slots.ts's.
import { useMemo, useSyncExternalStore } from 'react'
import type { PluginWorktree } from '../../../shared/plugins/client.ts'
import { PluginScope, usePluginEntries, type PluginEntry } from './PluginHost'
import { pluginActive } from './presence'
import { panelEntries, pluginSlotId, type PluginPanel } from './slots'

type WorktreeSlot = 'worktreePanel' | 'worktreeChip' | 'sidebarBadge' | 'hoverRow' | 'repoSettings'

/** The active plugins that fill a slot, in built-in order. */
export function useSlotEntries(name: WorktreeSlot): PluginEntry[] {
  const entries = usePluginEntries()
  return useMemo(() => entries.filter((e) => pluginActive(e.status) && !!e.plugin.slots?.[name]), [entries, name])
}

/** The worktree's Run-menu entries from the plugins, kept current with each plugin's own state. */
export function usePluginPanels(worktree: PluginWorktree | undefined): PluginPanel[] {
  const sources = useSlotEntries('worktreePanel')
  const subscribe = useMemo(
    () => (listener: () => void) => {
      const offs = sources.map((e) => {
        try {
          return e.plugin.slots!.worktreePanel!.subscribe(listener)
        } catch (err) {
          console.error(`[plugin ${e.plugin.manifest.id}] its Run menu subscription failed`, err)
          return () => {}
        }
      })
      return () => offs.forEach((off) => off())
    },
    [sources]
  )
  const key = useSyncExternalStore(subscribe, () => JSON.stringify(panelEntries(sources, worktree)))
  return useMemo(() => JSON.parse(key) as PluginPanel[], [key])
}

/** Each shown entry's panel, mounted while its entry shows; visible while it is the open one. */
export function PluginPanels({ worktree, panels, open }: { worktree: PluginWorktree; panels: readonly PluginPanel[]; open: string }): React.JSX.Element {
  const sources = useSlotEntries('worktreePanel')
  return (
    <>
      {panels.map((panel) => {
        const entry = sources.find((s) => s.plugin.manifest.id === panel.pluginId)
        if (!entry) return null
        const Panel = entry.plugin.slots!.worktreePanel!.Component
        return (
          <PluginScope key={entry.key} entry={entry}>
            <Panel worktree={worktree} visible={open === panel.panelId} />
          </PluginScope>
        )
      })}
    </>
  )
}

/** A worktree slot's components from every active plugin that fills it, in built-in order. */
export function PluginWorktreeSlot({
  name,
  worktree,
  openPanel
}: {
  name: 'worktreeChip' | 'sidebarBadge' | 'hoverRow'
  worktree: PluginWorktree
  /** worktreeChip only: opens the plugin's panel (its `plugin:<id>`) */
  openPanel?: (panelId: `plugin:${string}`) => void
}): React.JSX.Element {
  const entries = useSlotEntries(name)
  return (
    <>
      {entries.map((e) => {
        if (name === 'worktreeChip') {
          const Chip = e.plugin.slots!.worktreeChip!
          return (
            <PluginScope key={e.key} entry={e}>
              <Chip worktree={worktree} openPanel={() => openPanel?.(pluginSlotId(e.plugin.manifest.id))} />
            </PluginScope>
          )
        }
        const Slot = e.plugin.slots![name]!
        return (
          <PluginScope key={e.key} entry={e}>
            <Slot worktree={worktree} />
          </PluginScope>
        )
      })}
    </>
  )
}

/** A plugin's Settings tab: its id (`plugin:<id>`), label and entry. */
export interface PluginSettingsTab {
  id: `plugin:${string}`
  label: string
  entry: PluginEntry
}

/** The active plugins' repository settings tabs, in built-in order. */
export function usePluginSettingsTabs(): PluginSettingsTab[] {
  const entries = useSlotEntries('repoSettings')
  return useMemo(() => entries.map((e) => ({ id: pluginSlotId(e.plugin.manifest.id), label: e.plugin.slots!.repoSettings!.title, entry: e })), [entries])
}

/** A plugin's settings tab body for the repository chosen in Settings. */
export function PluginRepoSettings({ tab, repoId }: { tab: PluginSettingsTab; repoId: string | undefined }): React.JSX.Element | null {
  const repos = useSyncExternalStore(tab.entry.host.onReposChanged, tab.entry.host.repos)
  const repo = repos.find((r) => r.id === repoId)
  if (!repo) return null
  const Component = tab.entry.plugin.slots!.repoSettings!.Component
  return (
    <PluginScope entry={tab.entry}>
      <Component repo={repo} />
    </PluginScope>
  )
}
