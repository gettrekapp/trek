import { useEffect, useState } from 'react'
import type { AppSettings } from '../../../shared/appSettings'

/**
 * The app-wide "Show notifications" switch (app-settings.json on this machine), in
 * every window's settings. Off: main raises no OS notifications for the servers'
 * sessions. The bell still lists them, and each project's audio alerts still sound.
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

  const toggle = (showNotifications: boolean): void => {
    setError(null)
    window.api.appSettings
      .update({ showNotifications })
      .then(setSettings)
      .catch((err: Error) => setError(`Could not save the setting: ${err.message}`))
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
          onChange={(e) => toggle(e.target.checked)}
        />
        <span className="settings-label">
          <span className="settings-name">Show notifications</span>
          <span className="settings-desc">
            On this computer, for every project: a system notification when a session on a server
            needs a decision, needs your attention or finishes. The bell lists them either way, and
            each project&apos;s audio alerts still play.
          </span>
          {error && <span className="settings-desc settings-warn">{error}</span>}
        </span>
      </label>
    </>
  )
}
