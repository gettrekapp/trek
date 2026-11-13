import { usePluginHost } from '../../../src/shared/plugins/client.ts'
import { updateVoiceConfig } from './playback.ts'
import { useVoiceStore } from './store.ts'

/** Active plays spoken summaries in this app's windows; Busy silences them (an app-wide setting). */
export function VoiceToggle(): React.JSX.Element | null {
  const host = usePluginHost()
  const voice = useVoiceStore((s) => s.settings)
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
      onClick={() => void updateVoiceConfig(host, { active: !active }).catch((err) => console.warn('Could not change Active/Busy', err))}
    >
      <span className="voice-toggle-dot" />
      {active ? 'Active' : 'Busy'}
    </button>
  )
}
