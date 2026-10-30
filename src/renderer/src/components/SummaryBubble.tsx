import { useAppStore } from '../store'
import { terminalLabel } from '../terminals'
import { stopSummary } from '../voice'

/** Floats while a spoken summary plays; clicking it stops the audio. */
export function SummaryBubble(): React.JSX.Element | null {
  const playing = useAppStore((s) => s.voicePlaying)
  const queued = useAppStore((s) => s.voiceQueued)
  if (!playing) return null
  const source = playing.terminalId ? terminalLabel(playing.terminalId) : 'Test'
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
