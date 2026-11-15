// Settings → Appearance → Theme (theme plugins phase 2): "Default" or one of the themes the
// window's server has installed. The choice is this app's, per server and project; it records the
// theme's id and the bundle hash the user accepted. Hidden where there is nothing to pick and
// nothing chosen (a server with no themes, or one older than installed plugins). Below it, where
// the server installs for a client, the Installed themes row (ThemeInstallRow).
import { useEffect, useState, useSyncExternalStore } from 'react'
import type { ThemeChoice } from '../../../shared/appSettings.ts'
import { themeNote } from './theme'
import { ThemeInstallRow } from './ThemeInstallRow'
import { getThemeLoad, subscribeThemeLoad } from './themeLoadStore'
import { useThemeChoice } from './useThemeChoice'

export function ThemeSetting(): React.JSX.Element | null {
  const { key, listed, canInstall, themes, choice, state } = useThemeChoice()
  const load = useSyncExternalStore(subscribeThemeLoad, getThemeLoad)
  const [error, setError] = useState<string | null>(null)
  // A save error is about the choice as it stood: once the stored choice or its state moves on, the row's own note shows again.
  const choiceId = choice?.id
  const choiceSha = choice?.sha256
  useEffect(() => setError(null), [key, choiceId, choiceSha, state.kind])
  if (key === null || !listed) return null
  // The dropdown where there is something to pick or something chosen; the install row wherever the server installs for a client.
  const showChoice = themes.length > 0 || state.kind !== 'none'
  if (!showChoice && !canInstall) return null

  const save = (value: ThemeChoice | null): void => {
    setError(null)
    window.api.appSettings.update({ themes: { [key]: value } }).catch((err: Error) => setError(`Could not save the theme choice. (${err.message})`))
  }
  const note = themeNote(state, load)

  return (
    <>
      {showChoice && (
        <div className="settings-row">
          <span className="settings-label">
            <span className="settings-name">Theme</span>
            <span className="settings-desc" data-theme-note={note.problem ? 'problem' : note.apply ? 'apply' : 'info'}>
              {error ?? note.text}
            </span>
          </span>
          <span className="appearance-color">
            {state.kind === 'changed' && (
              <button className="btn" onClick={() => save({ id: state.theme.id, sha256: state.theme.sha256 })}>
                Apply
              </button>
            )}
            <select
              className="settings-select"
              aria-label="Theme"
              value={choice?.id ?? ''}
              onChange={(e) => {
                const theme = themes.find((t) => t.id === e.target.value)
                save(theme ? { id: theme.id, sha256: theme.sha256 } : null)
              }}
            >
              <option value="">Default</option>
              {themes.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
              {state.kind === 'missing' && <option value={state.id}>{state.id} (not installed)</option>}
            </select>
          </span>
        </div>
      )}
      {/* Keyed by the window's server and project: a message or a request under way is never carried to another's row. */}
      {canInstall && <ThemeInstallRow key={key} themes={themes} />}
    </>
  )
}
