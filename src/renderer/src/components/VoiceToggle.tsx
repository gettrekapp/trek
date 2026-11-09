import { useAppStore } from '../store'
import { updateVoiceConfig } from '../voice'

/** Active plays spoken summaries in this app's windows; Busy silences them (an app-wide setting). */
export function VoiceToggle(): React.JSX.Element | null {
  const voice = useAppStore((s) => s.voice)
  if (!voice?.hasApiKey) return null
  const active = voice.active
  return (
    <button
      className={`voice-toggle ${active ? 'active' : 'busy'}`}
      title={
        active
          ? 'Active — spoken summaries play. Click to go Busy.'
          : 'Busy — spoken summaries are skipped. Click to go Active.'
      }
      onClick={() => void updateVoiceConfig({ active: !active }).catch((err) => console.warn('Could not change Active/Busy', err))}
    >
      <span className="voice-toggle-dot" />
      {active ? 'Active' : 'Busy'}
    </button>
  )
}
