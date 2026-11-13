// Settings' Plugins section (plugin system phase 1): each plugin's on/off for this project, then
// the settings section of each plugin that is on.
import { getBackend } from '../backend'
import { useAppStore } from '../store'
import { PluginScope, usePluginEntries } from './PluginHost'
import { pluginActive } from './presence'

export function PluginsSettings(): React.JSX.Element | null {
  const entries = usePluginEntries()
  const setPluginEnabled = useAppStore((s) => s.setPluginEnabled)
  if (entries.length === 0 || entries.every((e) => e.status === 'unknown')) return null
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
      {!legacyServer &&
        entries.map(({ plugin, status }) => (
          <label className="settings-row" key={plugin.manifest.id}>
            <input
              type="checkbox"
              disabled={status === 'missing'}
              checked={status === 'on'}
              onChange={(e) => setPluginEnabled(plugin.manifest.id, e.target.checked)}
            />
            <span className="settings-label">
              <span className="settings-name">{plugin.manifest.name}</span>
              <span className="settings-desc">
                {status === 'missing' ? 'This server is too old for this plugin: update it to use it here.' : plugin.manifest.description}
              </span>
            </span>
          </label>
        ))}
      {entries
        .filter((e) => pluginActive(e.status) && e.plugin.slots?.settings)
        .map((e) => {
          const Settings = e.plugin.slots!.settings!
          return (
            <PluginScope key={`${e.plugin.manifest.id}:${e.host.projectId}`} entry={e}>
              <Settings />
            </PluginScope>
          )
        })}
    </>
  )
}
