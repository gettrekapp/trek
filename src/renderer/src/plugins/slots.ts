// Which plugins fill a slot (campsite): the active ones that have it, in built-in order; and the
// plugins' worktree slots, decided (plugins E3): which Run-menu entries show for a worktree and the
// Run button's dot. Pure: WorktreeSlots.tsx renders what this picks.
import type { ClientPlugin, ClientPluginHost, PluginPanelEntry, PluginRunDot, PluginSlotName, PluginWorktree } from '../../../shared/plugins/client.ts'
import { pluginActive, type PluginStatus } from './presence.ts'

interface SlotEntry {
  plugin: Pick<ClientPlugin, 'slots'>
  status: PluginStatus
}

export function activeSlotEntries<E extends SlotEntry>(entries: readonly E[], name: PluginSlotName): E[] {
  return entries.filter((e) => pluginActive(e.status) && e.plugin.slots?.[name])
}

/** For a slot only one plugin may fill (sessionIndicator) */
export function firstActiveSlot<E extends SlotEntry>(entries: readonly E[], name: PluginSlotName): E | undefined {
  return activeSlotEntries(entries, name)[0]
}

/** A plugin and its host in this window */
export interface SlotSource {
  plugin: ClientPlugin
  host: ClientPluginHost
}

/** A shown Run-menu entry: the panel it opens is `panelId` */
export interface PluginPanel {
  pluginId: string
  panelId: `plugin:${string}`
  entry: PluginPanelEntry
}

/** A plugin's panel or Settings tab id in the window: `plugin:<id>` */
export const pluginSlotId = (pluginId: string): `plugin:${string}` => `plugin:${pluginId}`

/** Each plugin's Run-menu entry for the worktree, in plugin order; one whose `entry` throws is left out (logged). */
export function panelEntries(
  sources: readonly SlotSource[],
  worktree: PluginWorktree | undefined,
  log: (message: string, err?: unknown) => void = (message, err) => console.error(message, err)
): PluginPanel[] {
  if (!worktree) return []
  return sources.flatMap(({ plugin, host }) => {
    const slot = plugin.slots?.worktreePanel
    if (!slot) return []
    try {
      const entry = slot.entry(host, worktree)
      return entry ? [{ pluginId: plugin.manifest.id, panelId: pluginSlotId(plugin.manifest.id), entry }] : []
    } catch (err) {
      log(`[plugin ${plugin.manifest.id}] its Run menu entry failed and is left out`, err)
      return []
    }
  })
}

/** The Run button's dot: busy anywhere is attention, else running anywhere is running, else exited. */
export function runDot(dots: readonly (PluginRunDot | undefined)[]): PluginRunDot {
  if (dots.includes('attention')) return 'attention'
  return dots.includes('running') ? 'running' : 'exited'
}
