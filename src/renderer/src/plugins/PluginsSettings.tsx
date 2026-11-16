// Settings' Plugins tab (plugin system phase 1): one listing per plugin — its name, what it does
// and its switch for this project — with the plugin's own settings inside the listing while it is on.
import { getBackend } from '../backend'
import { useAppStore } from '../store'
import { PluginScope, usePluginEntries, type PluginEntry } from './PluginHost'
import { pluginActive } from './presence'

/** Whether Settings has anything to show for plugins: the Plugins tab shows with it. */
export function hasPluginSettings(entries: readonly PluginEntry[]): boolean {
  return entries.length > 0 && !entries.every((e) => e.status === 'unknown')
}

export function PluginsSettings(): React.JSX.Element | null {
  const entries = usePluginEntries()
  const setPluginEnabled = useAppStore((s) => s.setPluginEnabled)
  if (!hasPluginSettings(entries)) return null
  // A server older than plugins: no switches (its plugins are always on), only their sections.
  const legacyServer = getBackend().plugins.welcome()?.plugins === undefined
  return (
    <>
      <h3>Plugins</h3>
      {legacyServer && (
        <div className="settings-row">
          <span className="settings-desc">This server is older than Trek&apos;s plugins: update it to turn them on or off per project.</span>
        </div>
      )}
      {entries.map((entry) => {
        const { plugin, status } = entry
        const active = pluginActive(status)
        const Settings = active ? plugin.slots?.settings : undefined
        // An older server has no switches (its plugins are always on), so a plugin it does not run has nothing to show.
        if (legacyServer && !active) return null
        const text = (
          <span className="settings-label">
            <span className="settings-name">{plugin.manifest.name}</span>
            <span className="settings-desc">
              {status === 'missing' ? 'Not available on this server: it may be older than this plugin (update it), or the plugin failed to start there (see its log).' : plugin.manifest.description}
            </span>
          </span>
        )
        return (
          <div className={`plugin-item ${active ? 'on' : 'off'}`} key={plugin.manifest.id} data-plugin={plugin.manifest.id}>
            {legacyServer ? (
              <div className="settings-row plugin-head">{text}</div>
            ) : (
              <label className="settings-row plugin-head">
                {text}
                <span className="plugin-state">{status === 'missing' ? 'Not available' : status === 'on' ? 'On' : 'Off'}</span>
                <input
                  type="checkbox"
                  role="switch"
                  className="plugin-switch"
                  aria-label={`${plugin.manifest.name} for this project`}
                  disabled={status === 'missing'}
                  checked={status === 'on'}
                  onChange={(e) => setPluginEnabled(plugin.manifest.id, e.target.checked)}
                />
              </label>
            )}
            {/* The plugin's own section: its heading is the listing's, so the stylesheet hides it. */}
            {Settings && (
              <div className="plugin-settings">
                <PluginScope key={entry.key} entry={entry}>
                  <Settings />
                </PluginScope>
              </div>
            )}
          </div>
        )
      })}
    </>
  )
}
