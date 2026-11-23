// The campsite's Settings section: per-app switches for the strip, the terminal's hiker and the camp dog
// (turning the plugin off for the project hides everything, tab hikers included), and the world's
// sky and seasons (part 3d-1). Rows as the voice plugin's; the choices as the claude plugin's select.
import { usePluginHost } from '../../../src/shared/plugins/client.ts'
import type { CampsitePrefs } from '../shared/prefs.ts'
import { usePrefs } from './hooks.ts'

type SwitchKey = 'showCampsite' | 'showTerminalHiker' | 'showDog'
const ROWS: readonly { key: SwitchKey; label: string; hint: string }[] = [
  { key: 'showCampsite', label: 'Show the campsite', hint: 'The strip along the bottom of the window.' },
  { key: 'showTerminalHiker', label: "Show a hiker on each terminal's quick button row", hint: 'With what its session is doing.' },
  { key: 'showDog', label: 'Show the camp dog', hint: 'It runs around the campsite. Click it to pet it.' }
]

type ChoiceKey = 'sky' | 'seasons'
const CHOICES: readonly { key: ChoiceKey; label: string; hint: string; options: readonly (readonly [string, string])[] }[] = [
  { key: 'sky', label: 'Sky', hint: "Dawn, day, dusk and night by this computer's clock, or always dusk.", options: [['clock', 'Follow the clock'], ['dusk', 'Always dusk']] },
  { key: 'seasons', label: 'Seasons', hint: 'Snow in winter, flowers in spring, fireflies in summer, falling leaves in autumn.', options: [['north', 'Northern'], ['south', 'Southern'], ['off', 'Off']] }
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
      {CHOICES.map((row) => (
        <div key={row.key} className="settings-row">
          <span className="settings-label">
            <span className="settings-name">{row.label}</span>
            <span className="settings-desc">{row.hint}</span>
          </span>
          <select
            className="settings-select"
            aria-label={`Campsite ${row.label.toLowerCase()}`}
            disabled={!loaded}
            value={prefs[row.key]}
            onChange={(e) => setPref(row.key, e.target.value as CampsitePrefs[ChoiceKey])}
          >
            {row.options.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>
      ))}
    </>
  )
}
