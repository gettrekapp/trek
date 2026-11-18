// Settings' Plugins tab: the plugins as a list (grouped by how each stands in this project) and
// the selected one's detail beside it — its switch for this project and, while it is on, its own
// settings. In a narrow panel the list fills the tab and a row opens its detail (styles.css).
// The rules are pluginsTab.ts's; the selection is SettingsPanel's.
import { useLayoutEffect, useRef } from 'react'
import { useListDetail } from '../components/useListDetail'
import { getBackend } from '../backend'
import { useAppStore } from '../store'
import { PluginScope, usePluginEntries, type PluginEntry } from './PluginHost'
import { pluginActive, type PluginStatus } from './presence'
import { pluginDetailNote, pluginGroups, pluginSwitchLabel, resolveSelection, type PluginRow, type PluginSelection } from './pluginsTab'

/** Whether Settings has anything to show for plugins: the Plugins tab shows with it. */
export function hasPluginSettings(entries: readonly PluginEntry[]): boolean {
  return entries.length > 0 && !entries.every((e) => e.status === 'unknown')
}

interface Props {
  /** The row the user picked; null before any pick (the first row shows) */
  chosen: PluginSelection | null
  onChoose: (selection: PluginSelection) => void
}

/**
 * The project's switch for a plugin: a checkbox drawn as a switch. Nothing on a server older than
 * plugins. `label` is its accessible name where the words beside it are not the default's.
 */
function PluginSwitch({ row, label, onChange }: { row: PluginRow; label?: string; onChange: (enabled: boolean) => void }): React.JSX.Element | null {
  if (row.control === 'none') return null
  return (
    <input
      type="checkbox"
      role="switch"
      className="plugin-switch"
      aria-label={label ?? `${row.name} for this project`}
      disabled={row.control === 'disabled'}
      checked={row.status === 'on'}
      onChange={(e) => onChange(e.target.checked)}
    />
  )
}

/** A plugin's tile: the first letter of its name. */
function PluginIcon({ name, large }: { name: string; large?: true }): React.JSX.Element {
  return (
    <span className={`plugins-icon${large ? ' large' : ''}`} aria-hidden="true">
      {name.trim().slice(0, 1).toUpperCase()}
    </span>
  )
}

export function PluginsSettings({ chosen, onChoose }: Props): React.JSX.Element | null {
  const entries = usePluginEntries()
  const setPluginEnabled = useAppStore((s) => s.setPluginEnabled)
  const projectName = useAppStore((s) => s.project?.name ?? '')
  const pane = useListDetail({ hasSelection: chosen !== null, scroller: '.settings-scroll', selectedRow: '.plugins-row.selected .plugins-row-main' })
  const root = pane.root

  /** The plugin whose list switch was just flipped, and what to: until the next change of any row's group. */
  const flipped = useRef<{ id: string; to: PluginStatus } | null>(null)
  // The groups are these statuses' (pluginGroups): a change here is a row changing group.
  const standing = entries.map((e) => `${e.plugin.manifest.id}:${e.status}`).join('|')
  useLayoutEffect(() => {
    const pending = flipped.current
    flipped.current = null
    // A flip that did not take (the change is another row's, or this one's being undone) leaves the focus alone.
    if (!pending || entries.find((e) => e.plugin.manifest.id === pending.id)?.status !== pending.to) return
    // The row was remounted in another group, which took the focus off its switch: put it back,
    // unless the user has moved the focus somewhere else since.
    const active = document.activeElement
    if (active && active !== document.body && active.isConnected) return
    root.current?.querySelector<HTMLElement>(`.plugins-list [data-plugin="${CSS.escape(pending.id)}"] input.plugin-switch`)?.focus({ preventScroll: true })
    // `standing` stands for the entries' statuses, which is all this reads of them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [standing])

  if (!hasPluginSettings(entries)) return null
  // A server older than plugins: no switches (its plugins are always on), only their sections.
  const legacyServer = getBackend().plugins.welcome()?.plugins === undefined
  const groups = pluginGroups(
    entries.map((e) => ({ id: e.plugin.manifest.id, name: e.plugin.manifest.name, status: e.status })),
    projectName,
    legacyServer
  )
  const selection = resolveSelection(groups, chosen)
  const selectedRow = selection ? groups.flatMap((g) => g.rows).find((r) => r.id === selection.id) : undefined
  const selectedEntry = selection ? entries.find((e) => e.plugin.manifest.id === selection.id) : undefined

  const open = (id: string): void => {
    onChoose({ kind: 'plugin', id })
    pane.open()
  }
  const flip = (id: string, enabled: boolean): void => {
    flipped.current = { id, to: enabled ? 'on' : 'off' }
    setPluginEnabled(id, enabled)
  }

  const Settings = selectedEntry && pluginActive(selectedEntry.status) ? selectedEntry.plugin.slots?.settings : undefined
  const note = selectedEntry ? pluginDetailNote(selectedEntry.status) : null
  const switchLabel = selectedRow ? pluginSwitchLabel(selectedRow.status, projectName) : ''
  // A label only around a switch that works: with none, or a disabled one, the words are not a control's.
  const working = selectedRow?.control === 'switch'
  const SwitchWrap = working ? 'label' : 'div'

  return (
    <div className={`list-detail plugins-tab${pane.showDetail ? ' detail-open' : ''}`} ref={root}>
      <nav className="list-detail-list plugins-list" aria-label="Plugins">
        {/* Not drawn: the groups' h4s and the detail's h3 need a heading above them. */}
        <h3 className="plugins-heading">Plugins</h3>
        {legacyServer && <p className="settings-desc plugins-legacy">This server is older than Trek&apos;s plugins: update it to turn them on or off per project.</p>}
        {groups.map((group) => (
          <section key={group.id} className="plugins-group" aria-label={group.heading}>
            <h4 className="plugins-group-head">{group.heading}</h4>
            {group.rows.map((row) => (
              <div key={row.id} className={`plugins-row${row.id === selection?.id ? ' selected' : ''}${row.dim ? ' dim' : ''}`} data-plugin={row.id}>
                <button type="button" className="plugins-row-main" aria-current={row.id === selection?.id ? 'true' : undefined} onClick={() => open(row.id)}>
                  <PluginIcon name={row.name} />
                  <span className="plugins-row-text">
                    <span className="plugins-row-name">{row.name}</span>
                    {row.line && <span className="plugins-row-line">{row.line}</span>}
                  </span>
                </button>
                <PluginSwitch row={row} onChange={(enabled) => flip(row.id, enabled)} />
                <span className="list-detail-chevron plugins-chevron" aria-hidden="true">
                  ›
                </span>
              </div>
            ))}
          </section>
        ))}
        {!legacyServer && <p className="settings-desc plugins-scope">Switches are for this project. Keys and other setup are shared by every project on the server.</p>}
      </nav>

      {selectedEntry && selectedRow && (
        <section className="list-detail-detail plugins-detail" aria-label={selectedRow.name}>
          <button type="button" className="list-detail-back plugins-back" ref={pane.backButton} onClick={pane.back}>
            ‹ Plugins
          </button>
          <div className="plugins-detail-head">
            <PluginIcon name={selectedRow.name} large />
            <div className="plugins-detail-text">
              <h3>
                {selectedRow.name} <span className="plugins-version">{selectedEntry.plugin.manifest.version} · Built in</span>
              </h3>
              <p className="settings-desc">{selectedEntry.plugin.manifest.description}</p>
            </div>
            <SwitchWrap className={`plugins-detail-switch${working ? '' : ' static'}`}>
              <span>{switchLabel}</span>
              <PluginSwitch row={selectedRow} label={`${selectedRow.name}: ${switchLabel}`} onChange={(enabled) => setPluginEnabled(selectedRow.id, enabled)} />
            </SwitchWrap>
          </div>
          {note && <p className="settings-desc plugins-note">{note}</p>}
          {/* The plugin's own section: its heading is the detail's, so the stylesheet hides it. */}
          {Settings && (
            <div className="plugin-settings">
              <PluginScope key={selectedEntry.key} entry={selectedEntry}>
                <Settings />
              </PluginScope>
            </div>
          )}
        </section>
      )}
    </div>
  )
}
