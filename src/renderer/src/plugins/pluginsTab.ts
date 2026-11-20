// Settings → Plugins (the list-and-detail tab): how the plugins group into the list, what each
// row says, which row is selected, and the detail pane's words. Pure: imported by tests.
import type { PluginStatus } from './presence.ts'

/** A plugin as the tab needs it: from a PluginEntry's manifest and status. */
export interface PluginRowInput {
  id: string
  name: string
  status: PluginStatus
  /** The server lists it as required (plugins A1b): on in every project, its switch locked */
  required?: boolean
}

/** The selected row. `theme` is for installed themes (a later phase): a theme may carry a built-in's id, so the kind is part of the selection. */
export interface PluginSelection {
  kind: 'plugin' | 'theme'
  id: string
}

export interface PluginRow extends PluginRowInput {
  /** The row's second line; null where it has none */
  line: string | null
  /** The project's switch, the same switch disabled, or no control (a server older than plugins) */
  control: 'switch' | 'disabled' | 'none'
  /** The name is drawn muted */
  dim: boolean
}

export type PluginGroupId = 'on' | 'off' | 'missing' | 'legacy'

export interface PluginGroup {
  id: PluginGroupId
  heading: string
  rows: PluginRow[]
}

const LINES: Record<PluginStatus, string | null> = {
  on: null,
  off: 'Off in this project',
  missing: 'Not available on this server',
  legacy: 'Always on · update the server to switch it',
  unknown: null
}

/** A row's second line, from the plugin's status alone. */
export const pluginRowLine = (status: PluginStatus): string | null => LINES[status]

const projectWords = (projectName: string): string => projectName || 'this project'

function toRow(input: PluginRowInput): PluginRow {
  const locked = input.required === true && input.status === 'on'
  return {
    id: input.id,
    name: input.name,
    status: input.status,
    line: locked ? 'Always on' : pluginRowLine(input.status),
    control: input.status === 'legacy' ? 'none' : input.status === 'missing' || locked ? 'disabled' : 'switch',
    dim: input.status === 'off' || input.status === 'missing'
  }
}

const HEADINGS: Record<Exclude<PluginGroupId, 'legacy'>, (count: number, projectName: string) => string> = {
  on: (count, projectName) => `On in ${projectWords(projectName)} · ${count}`,
  off: (count) => `Off · ${count}`,
  missing: (count) => `Not available · ${count}`
}

const ORDER = ['on', 'off', 'missing'] as const

/**
 * The list's groups, in order, each with its rows in the plugins' own order; a group with no row
 * is left out. A server older than plugins (`legacyServer`) has one group: what it runs, with no
 * switch. A plugin whose status is not known yet is not listed.
 */
export function pluginGroups(inputs: readonly PluginRowInput[], projectName: string, legacyServer: boolean): PluginGroup[] {
  if (legacyServer) {
    const rows = inputs.filter((i) => i.status === 'legacy').map(toRow)
    return rows.length > 0 ? [{ id: 'legacy', heading: `On this server · ${rows.length}`, rows }] : []
  }
  const groups: PluginGroup[] = []
  for (const id of ORDER) {
    const rows = inputs.filter((i) => i.status === id).map(toRow)
    if (rows.length > 0) groups.push({ id, heading: HEADINGS[id](rows.length, projectName), rows })
  }
  return groups
}

/** The row on show: the chosen one while the list holds it, else the list's first row; null with no rows. */
export function resolveSelection(groups: readonly PluginGroup[], chosen: PluginSelection | null): PluginSelection | null {
  const rows = groups.flatMap((g) => g.rows)
  if (chosen?.kind === 'plugin' && rows.some((r) => r.id === chosen.id)) return chosen
  return rows.length > 0 ? { kind: 'plugin', id: rows[0].id } : null
}

/** What the plugin's detail says (null: nothing): in place of its settings while it is off or missing, and above them for a required one. */
export function pluginDetailNote(status: PluginStatus, about: { required?: boolean; offersAgents?: boolean } = {}): string | null {
  if (about.required === true && status === 'on') return "Always on: sessions fall back to its agent, so it can't be turned off."
  if (status === 'off') {
    return about.offersAgents === true
      ? 'Its agents are hidden for new sessions in this project. Sessions already running keep going and can restart. Turn it on to use them again.'
      : 'Turn it on to set it up for this project.'
  }
  if (status === 'missing') return 'Not available on this server: it may be older than this plugin (update it), or the plugin failed to start there (see its log).'
  return null
}

/** The words beside the detail pane's switch: the switch's state and its scope. */
export function pluginSwitchLabel(status: PluginStatus, projectName: string, required = false): string {
  if (status === 'missing') return 'Not available'
  if (status === 'legacy' || (required && status === 'on')) return 'Always on'
  return `${status === 'on' ? 'On' : 'Off'} for ${projectWords(projectName)}`
}
