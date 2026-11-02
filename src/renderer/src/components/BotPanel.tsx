import { useEffect, useRef, useState } from 'react'
import { useAppStore } from '../store'
import { allowBot, disableBot, enableBot, locateBotFolder, retryBot, startNewBot } from '../bot'

const clock = (at: number | null): string =>
  at ? new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—'

const PHASE_LABEL = { off: 'Off', idle: 'Idle', working: 'Working', paused: 'Paused', error: 'Stopped' }

/** Status, activity, approvals and a message box for the project's bot. */
export function BotPanel({ visible }: { visible: boolean }): React.JSX.Element {
  const view = useAppStore((s) => s.botView)
  const events = useAppStore((s) => s.botEvents)
  const filePath = useAppStore((s) => s.filePath)
  const claudeCommand = useAppStore((s) => s.project?.claudeCommand)
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const feedRef = useRef<HTMLDivElement>(null)
  const sending = useRef(false)

  useEffect(() => {
    const feed = feedRef.current
    if (feed) feed.scrollTop = feed.scrollHeight
  }, [events.length, visible])

  const guard = (action: () => Promise<void> | void): void => {
    setError(null)
    Promise.resolve()
      .then(action)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
  }

  /** The draft stays until main has the message, so a failed send loses nothing. */
  const send = (): void => {
    const text = draft.trim()
    if (!text || sending.current) return
    sending.current = true
    setError(null)
    window.api
      .botSend(text)
      .then(() => setDraft((current) => (current.trim() === text ? '' : current)))
      .catch((err) => setError(String(err)))
      .finally(() => {
        sending.current = false
      })
  }

  const style = { display: visible ? 'flex' : 'none' }

  if (view.needsConsent) {
    return (
      <div className="bot-panel bot-empty bot-consent" style={style}>
        <p>This project wants to run a bot from this folder with this command:</p>
        <code>{view.folder}</code>
        <code>{view.command}</code>
        <p>It runs unattended on a heartbeat and uses your Claude usage. Nothing runs unless you allow it.</p>
        <span className="bot-actions">
          <button className="btn btn-ghost" onClick={() => guard(allowBot)}>
            Allow
          </button>
          <button className="btn btn-ghost" onClick={() => guard(disableBot)}>
            Disable
          </button>
        </span>
        {error && <div className="global-error bot-reason">{error}</div>}
      </div>
    )
  }

  if (view.phase === 'off') {
    return (
      <div className="bot-panel bot-empty" style={style}>
        {filePath ? (
          <>
            <p>
              The project bot watches this project on a heartbeat, keeps its own memory, and asks before
              outward-facing actions. It runs unattended using{' '}
              <code>{claudeCommand?.trim() || 'claude'}</code> and your Claude usage.
            </p>
            <button className="btn btn-ghost" onClick={() => guard(enableBot)}>
              Enable bot
            </button>
          </>
        ) : (
          <p>Save this project to enable its bot. Its memory folder sits next to the project file.</p>
        )}
        {error && <div className="global-error bot-reason">{error}</div>}
      </div>
    )
  }

  // Without a bot behind this view, main ignores everything but Disable, Locate and Start new.
  const live = view.bound && !view.folderMissing
  const halted = view.phase === 'paused' || view.phase === 'error'

  return (
    <div className="bot-panel" style={style}>
      <div className="bot-status">
        <span className={`bot-phase phase-${view.phase}`}>{PHASE_LABEL[view.phase]}</span>
        {view.queued > 0 && <span className="muted">{view.queued} queued</span>}
        {live && (
          <span className="muted">
            Last beat {clock(view.lastBeatAt)} · next {clock(view.nextBeatAt)}
          </span>
        )}
        <span className="bot-actions">
          {live && (
            <>
              <button className="btn btn-ghost" onClick={() => guard(() => window.api.botSetPaused(!halted))}>
                {halted ? 'Resume' : 'Pause'}
              </button>
              <button className="btn btn-ghost" onClick={() => guard(() => window.api.botOpenFolder())}>
                Open folder
              </button>
            </>
          )}
          <button className="btn btn-ghost" onClick={() => guard(disableBot)}>
            Disable
          </button>
        </span>
      </div>
      {view.reason && <div className="global-error bot-reason">{view.reason}</div>}
      {view.folderMissing && (
        <div className="bot-approval">
          <button className="btn btn-ghost" onClick={() => guard(locateBotFolder)}>
            Locate folder…
          </button>
          <button className="btn btn-ghost" onClick={() => guard(startNewBot)}>
            Start new
          </button>
        </div>
      )}
      {view.folderInUse && (
        <div className="bot-approval">
          <button className="btn btn-ghost" onClick={() => guard(retryBot)}>
            Retry
          </button>
        </div>
      )}
      {live &&
        view.approvals.map((a) => (
          <div key={a.id} className="bot-approval">
            <div className="bot-approval-text">
              <strong>{a.reason}</strong>
              <code>
                {a.tool} {JSON.stringify(a.input)}
              </code>
            </div>
            <button className="btn btn-ghost" onClick={() => guard(() => window.api.botDecide(a.id, true))}>
              Approve
            </button>
            <button className="btn btn-ghost" onClick={() => guard(() => window.api.botDecide(a.id, false))}>
              Deny
            </button>
          </div>
        ))}
      <div className="bot-feed" ref={feedRef}>
        {events.map((e, i) => (
          <div key={i} className={`bot-event event-${e.kind}`}>
            <span className="bot-event-time">{clock(e.at)}</span>
            <span className="bot-event-text">{e.text}</span>
          </div>
        ))}
      </div>
      {error && <div className="global-error bot-reason">{error}</div>}
      <textarea
        className="bot-input"
        rows={2}
        placeholder="Message the bot. Enter sends, Shift+Enter adds a line."
        value={draft}
        disabled={!live}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            send()
          }
        }}
      />
    </div>
  )
}
