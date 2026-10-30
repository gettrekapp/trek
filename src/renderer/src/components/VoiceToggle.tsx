import { useAppStore } from '../store'
import { updateVoiceConfig } from '../voice'

/** Active plays spoken summaries; Busy silences them. */
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
      onClick={() => void updateVoiceConfig({ active: !active })}
    >
      <span className="voice-toggle-dot" />
      {active ? 'Active' : 'Busy'}
    </button>
  )
}
