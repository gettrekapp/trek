// The campsite's Settings section: per-app switches for the strip, the terminal's hiker and the camp dog
// (turning the plugin off for the project hides everything, tab hikers included). Rows as the
// voice plugin's.
import { usePluginHost } from '../../../src/shared/plugins/client.ts'
import type { CampsitePrefKey } from '../shared/prefs.ts'
import { usePrefs } from './hooks.ts'

const ROWS: readonly { key: CampsitePrefKey; label: string; hint: string }[] = [
  { key: 'showCampsite', label: 'Show the campsite', hint: 'The strip along the bottom of the window.' },
  { key: 'showTerminalHiker', label: "Show a hiker on each terminal's quick button row", hint: 'With what its session is doing.' },
  { key: 'showDog', label: 'Show the camp dog', hint: 'It runs around the campsite. Click it to pet it.' }
]

export function CampsiteSettings(): React.JSX.Element {
  const host = usePluginHost()
  const [{ loaded, prefs }, setPref] = usePrefs(host)
  return (
    <>
      <h3>Campsite</h3>
      <p className="settings-desc">These are for this app, in every project window.</p>
      {ROWS.map((row) => (
        <label key={row.key} className="settings-row">
          <input type="checkbox" disabled={!loaded} checked={prefs[row.key]} onChange={(e) => setPref(row.key, e.target.checked)} />
          <span className="settings-label">
            <span className="settings-name">{row.label}</span>
            <span className="settings-desc">{row.hint}</span>
          </span>
        </label>
      ))}
    </>
  )
}
