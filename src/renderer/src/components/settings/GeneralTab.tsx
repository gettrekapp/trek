import { useAppStore } from '../../store'
import { useFeatures } from '../../useFeatures'
import { AppearanceSettings } from '../AppearanceSettings'
import { NotificationSettings } from '../NotificationSettings'

/** Settings → General: how the project looks, its Tasks page, what notifies, and the Local server. */
export function GeneralTab(): React.JSX.Element {
  const audioAlerts = useAppStore((s) => s.project?.audioAlerts ?? false)
  const setAudioAlerts = useAppStore((s) => s.setAudioAlerts)
  const tasksFeature = useFeatures().tasks
  const tasksEnabled = useAppStore((s) => s.project?.tasksEnabled !== false)
  const setTasksEnabled = useAppStore((s) => s.setTasksEnabled)
  return (
    <>
      <AppearanceSettings />
      {tasksFeature && (
        <>
          <h3>Tasks</h3>
          <label className="settings-row">
            <input type="checkbox" aria-label="Tasks" checked={tasksEnabled} onChange={(e) => setTasksEnabled(e.target.checked)} />
            <span className="settings-label">
              <span className="settings-name">Tasks</span>
              <span className="settings-desc">Show the Tasks page and let agents use the Tasks tools. Turning it off keeps your tasks.</span>
            </span>
          </label>
        </>
      )}
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
