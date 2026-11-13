import { usePluginHost } from '../../../src/shared/plugins/client.ts'
import { stopSummary } from './playback.ts'
import { useVoiceStore } from './store.ts'

/** Floats while a spoken summary plays; clicking it stops the audio. */
export function SummaryBubble(): React.JSX.Element | null {
  const host = usePluginHost()
  const playing = useVoiceStore((s) => s.playing)
  const queued = useVoiceStore((s) => s.queued)
  if (!playing) return null
  const source = playing.terminalId ? host.terminalLabel(playing.terminalId) : 'Test'
  return (
    <button className="summary-bubble" title="Click to stop" onClick={stopSummary}>
      <span className="summary-bubble-wave" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      <span className="summary-bubble-body">
        <span className="summary-bubble-source">
          {source}
          {queued > 0 && <span className="summary-bubble-queued"> · {queued} more queued</span>}
        </span>
        <span className="summary-bubble-text">{playing.text}</span>
      </span>
      <span className="summary-bubble-stop" aria-hidden="true">
        ■
      </span>
    </button>
  )
}
