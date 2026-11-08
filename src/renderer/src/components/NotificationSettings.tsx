import { useEffect, useState } from 'react'
import type { AppSettings } from '../../../shared/appSettings'

/**
 * The app-wide switches (app-settings.json on this machine), in every window's settings:
 * - "Show notifications". Off: main raises no OS notifications for the servers'
 *   sessions. The bell still lists them, and each project's audio alerts still sound.
 * - "Stop local server on quit". Off (the default): the Local server keeps running
 *   after Trek quits, and its sessions with it.
 */
export function NotificationSettings(): React.JSX.Element {
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    const off = window.api.appSettings.onChanged((next) => setSettings(next))
    window.api.appSettings
      .get()
      .then((s) => {
        if (live) setSettings((had) => had ?? s)
      })
      .catch((err: Error) => live && setError(err.message))
    return () => {
      live = false
      off()
    }
  }, [])

  const toggle = (patch: Partial<AppSettings>): void => {
    setError(null)
    // main applies the change at once and only the write can fail, so a failure still leaves it on for now.
    window.api.appSettings
      .update(patch)
      .then(setSettings)
      .catch((err: Error) => setError(`Could not save the setting — it applies until Trek quits. (${err.message})`))
  }

  return (
    <>
      <h3>Notifications</h3>
      <label className="settings-row">
        <input
          type="checkbox"
          aria-label="Show notifications"
          checked={settings?.showNotifications ?? true}
          disabled={settings === null}
          onChange={(e) => toggle({ showNotifications: e.target.checked })}
        />
        <span className="settings-label">
          <span className="settings-name">Show notifications</span>
          <span className="settings-desc">
            On this computer, for every project: a system notification when a session on a server
            needs a decision, needs your attention or finishes. The bell lists them either way, and
            each project&apos;s audio alerts still play.
          </span>
        </span>
      </label>
      <h3>Local server</h3>
      <label className="settings-row">
        <input
          type="checkbox"
          aria-label="Stop local server on quit"
          checked={settings?.stopLocalServerOnQuit ?? false}
          disabled={settings === null}
          onChange={(e) => toggle({ stopLocalServerOnQuit: e.target.checked })}
        />
        <span className="settings-label">
          <span className="settings-name">Stop local server on quit</span>
          <span className="settings-desc">
            Off: the Local server keeps running after Trek quits, so its agent sessions carry on and
            Trek finds them again at the next launch. On: quitting Trek stops it, and its sessions
            resume when their worktrees are opened again.
          </span>
        </span>
      </label>
      {error && <p className="settings-desc settings-warn">{error}</p>}
    </>
  )
}
