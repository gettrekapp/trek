import { useAppStore } from '../../store'
import { AppearanceSettings } from '../AppearanceSettings'
import { NotificationSettings } from '../NotificationSettings'

/** Settings → General: how the project looks, what notifies, and the Local server. */
export function GeneralTab(): React.JSX.Element {
  const audioAlerts = useAppStore((s) => s.project?.audioAlerts ?? false)
  const setAudioAlerts = useAppStore((s) => s.setAudioAlerts)
  return (
    <>
      <AppearanceSettings />
      <NotificationSettings
        afterNotifications={
          <label className="settings-row">
            <input
              type="checkbox"
              checked={audioAlerts}
              onChange={(e) => {
                setAudioAlerts(e.target.checked)
              }}
            />
            <span className="settings-label">
              <span className="settings-name">Audio alerts</span>
              <span className="settings-desc">
                Play a sound when an agent terminal finishes working and is ready for input
              </span>
            </span>
          </label>
        }
      />
    </>
  )
}
