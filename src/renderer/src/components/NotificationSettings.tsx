import { useEffect, useState } from 'react'
import type { AppSettings } from '../../../shared/appSettings'

/**
 * The app-wide switches (app-settings.json on this machine), in every window's settings:
 * - "Show notifications". Off: main raises no OS notifications for the servers'
 *   sessions. The bell still lists them, and each project's audio alerts still sound.
 * - "Stop local server on quit". Off (the default): the Local server keeps running
 *   after Trek quits, and its sessions with it.
 * - "Saved tokens", only when they are stored unencrypted (Linux without a keyring).
 *
 * `afterNotifications` is the project's own row under "Notifications" (its audio alerts).
 */
export function NotificationSettings({ afterNotifications }: { afterNotifications?: React.ReactNode }): React.JSX.Element {
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [storage, setStorage] = useState<'encrypted' | 'unencrypted' | null>(null)
  useEffect(() => {
    let live = true
    window.api
      .secretStorage()
      .then((kind) => {
        if (live) setStorage(kind)
      })
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [])

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
      {afterNotifications}
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
      {storage === 'unencrypted' && (
        <>
          <h3>Saved tokens</h3>
          <p className="settings-desc settings-warn">
            This computer has no keyring Trek can use, so server tokens are stored unencrypted in
            Trek&apos;s settings folder (readable only by your user). Install and unlock GNOME Keyring or
            KWallet, then restart Trek, to encrypt the tokens saved from then on.
          </p>
        </>
      )}
      {error && <p className="settings-desc settings-warn">{error}</p>}
    </>
  )
}
