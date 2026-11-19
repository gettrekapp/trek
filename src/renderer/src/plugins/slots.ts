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

type Log = (message: string, err?: unknown) => void

const consoleLog: Log = (message, err) => console.error(message, err)

/** The plugins already warned about, by plugin and what failed: the window renders often, so each is logged once. */
const warned = new Set<string>()

function warnOnce(pluginId: string, what: string, message: string, err: unknown, log: Log): void {
  const key = `${pluginId} ${what}`
  if (warned.has(key)) return
  warned.add(key)
  log(message, err)
}

const DOTS: readonly PluginRunDot[] = ['running', 'exited', 'attention']

/** A plugin's entry as plain data the window can stringify and render: a string label, a string title, a known dot. */
function normalEntry(raw: PluginPanelEntry): PluginPanelEntry {
  const label = String(raw.label)
  const title: unknown = raw.title
  const dot: unknown = raw.dot
  return {
    label,
    ...(typeof title === 'string' ? { title } : {}),
    ...(typeof dot === 'string' && (DOTS as readonly string[]).includes(dot) ? { dot: dot as PluginRunDot } : {})
  }
}

/**
 * Each plugin's Run-menu entry for the worktree, in plugin order, normalised; one whose `entry`
 * throws (or whose label can't be read) is left out, warned about once.
 */
export function panelEntries(sources: readonly SlotSource[], worktree: PluginWorktree | undefined, log: Log = consoleLog): PluginPanel[] {
  if (!worktree) return []
  return sources.flatMap(({ plugin, host }) => {
    const slot = plugin.slots?.worktreePanel
    if (!slot) return []
    try {
      const entry = slot.entry(host, worktree)
      return entry && typeof entry === 'object'
        ? [{ pluginId: plugin.manifest.id, panelId: pluginSlotId(plugin.manifest.id), entry: normalEntry(entry) }]
        : []
    } catch (err) {
      warnOnce(plugin.manifest.id, 'entry', `[plugin ${plugin.manifest.id}] its Run menu entry failed and is left out`, err, log)
      return []
    }
  })
}

/**
 * Subscribes `listener` to each plugin's own state behind its Run-menu entry and to its host's
 * repositories. A subscribe that throws is warned about once; one that returns no function, and
 * an unsubscribe that throws (logged), change nothing else. Returns the unsubscribe of them all.
 */
export function subscribeAll(sources: readonly SlotSource[], listener: () => void, log: Log = consoleLog): () => void {
  const offs: { pluginId: string; off: () => void }[] = []
  const add = (pluginId: string, subscribe: () => unknown, what: string): void => {
    try {
      const off = subscribe()
      if (typeof off === 'function') offs.push({ pluginId, off: off as () => void })
    } catch (err) {
      warnOnce(pluginId, what, `[plugin ${pluginId}] its ${what} failed`, err, log)
    }
  }
  for (const { plugin, host } of sources) {
    const id = plugin.manifest.id
    const slot = plugin.slots?.worktreePanel
    if (slot) add(id, () => slot.subscribe(listener), 'Run menu subscription')
    add(id, () => host.onReposChanged(listener), 'repositories subscription')
  }
  return () => {
    for (const { pluginId, off } of offs) {
      try {
        off()
      } catch (err) {
        log(`[plugin ${pluginId}] its unsubscribe failed`, err)
      }
    }
  }
}

/** The Run button's dot: busy anywhere is attention, else running anywhere is running, else exited. */
export function runDot(dots: readonly (PluginRunDot | undefined)[]): PluginRunDot {
  if (dots.includes('attention')) return 'attention'
  return dots.includes('running') ? 'running' : 'exited'
}
