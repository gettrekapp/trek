// Settings' Plugins tab: the plugins as a list (grouped by how each stands in this project) and
// the selected one's detail beside it — its switch for this project and, while it is on, its own
// settings. In a narrow panel the list fills the tab and a row opens its detail (styles.css).
// The rules are pluginsTab.ts's; the selection is SettingsPanel's.
import { useLayoutEffect, useRef, useState } from 'react'
import { getBackend } from '../backend'
import { useAppStore } from '../store'
import { PluginScope, usePluginEntries, type PluginEntry } from './PluginHost'
import { pluginActive } from './presence'
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

/** The project's switch for a plugin: a checkbox drawn as a switch. Nothing on a server older than plugins. */
function PluginSwitch({ row, onChange }: { row: PluginRow; onChange: (enabled: boolean) => void }): React.JSX.Element | null {
  if (row.control === 'none') return null
  return (
    <input
      type="checkbox"
      role="switch"
      className="plugin-switch"
      aria-label={`${row.name} for this project`}
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
  // A narrow panel shows the list or the detail, never both: which one. A wide panel ignores it.
  const [detailOpen, setDetailOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  /** Where the list was scrolled when a row was opened, put back when Back returns to it. */
  const listScroll = useRef(0)
  const restoreScroll = useRef(false)
  const scroller = (): Element | null => root.current?.closest('.settings-scroll') ?? null
  useLayoutEffect(() => {
    if (!restoreScroll.current) return
    restoreScroll.current = false
    const el = scroller()
    if (el) el.scrollTop = listScroll.current
  }, [detailOpen])

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
    listScroll.current = scroller()?.scrollTop ?? 0
    onChoose({ kind: 'plugin', id })
    setDetailOpen(true)
  }
  const back = (): void => {
    restoreScroll.current = true
    setDetailOpen(false)
  }

  const Settings = selectedEntry && pluginActive(selectedEntry.status) ? selectedEntry.plugin.slots?.settings : undefined
  const note = selectedEntry ? pluginDetailNote(selectedEntry.status) : null

  return (
    <div className={`plugins-tab${detailOpen ? ' detail-open' : ''}`} ref={root}>
      <nav className="plugins-list" aria-label="Plugins">
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
                <PluginSwitch row={row} onChange={(enabled) => setPluginEnabled(row.id, enabled)} />
                <span className="plugins-chevron" aria-hidden="true">
                  ›
                </span>
              </div>
            ))}
          </section>
        ))}
        {!legacyServer && <p className="settings-desc plugins-scope">Switches are for this project. Keys and other setup are shared by every project on the server.</p>}
      </nav>

      {selectedEntry && selectedRow && (
        <section className="plugins-detail" aria-label={selectedRow.name}>
          <button type="button" className="plugins-back" onClick={back}>
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
            <label className="plugins-detail-switch">
              <span>{pluginSwitchLabel(selectedRow.status, projectName)}</span>
              <PluginSwitch row={selectedRow} onChange={(enabled) => setPluginEnabled(selectedRow.id, enabled)} />
            </label>
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
