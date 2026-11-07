import { useEffect, useRef } from 'react'
import { useAppStore } from '../store'
import { agentLabel, attachTerminal, fitTerminal, focusTerminal, sendV2Size } from '../terminals'
import { getBackend } from '../backend'
import { QueuePanel } from './QueuePanel'
import { STATUS_LABELS } from '../../../shared/appServerRules.ts'
import type { ConnectionStatus } from '../../../shared/client/connection.ts'

/**
 * The overlay's title: "Reconnecting" only for the statuses the SDK retries
 * out of by itself; otherwise what the status is (the banner has the details).
 */
function offlineTitle(link: ConnectionStatus | null): string {
  if (link === 'connecting' || link === 'disconnected') return 'Reconnecting to the server…'
  return link && link !== 'connected' ? STATUS_LABELS[link] : 'Disconnected from the server'
}

interface Props {
  terminalId: string
  visible: boolean
  /** Shows the global Claude quick buttons instead of the worktree ones */
  global?: boolean
  /** Why the pane restarts nothing (the read-only Global panel); unset, it may */
  readOnly?: string
}

export function TerminalPane({ terminalId, visible, global = false, readOnly }: Props): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const status = useAppStore((s) => s.terminals[terminalId]?.status)
  // Subscribed so the restart label follows the session's agent.
  const llm = useAppStore((s) => s.terminals[terminalId]?.llm)
  const quickButtons = useAppStore((s) =>
    global ? s.project?.globalTerminalButtons : s.project?.terminalButtons
  )
  // A server window whose link is down: input would be dropped, so the pane is covered.
  const offline = useAppStore((s) => s.serverOffline)
  const link = useAppStore((s) => s.serverLink)
  // The agent's command is a setting of this machine, or of the server's config in a server window.
  const serverWindow = useAppStore((s) => s.serverWindow !== null)

  useEffect(() => {
    if (!ref.current) return
    attachTerminal(terminalId, ref.current)
    const observer = new ResizeObserver(() => fitTerminal(terminalId))
    observer.observe(ref.current)
    return () => observer.disconnect()
  }, [terminalId])

  useEffect(() => {
    if (visible) {
      requestAnimationFrame(() => {
        // A server window's pty keeps the last resizer's size: claim it on every show (it fits too).
        if (!sendV2Size(terminalId)) fitTerminal(terminalId)
        focusTerminal(terminalId)
      })
    }
  }, [visible, terminalId])

  // Back online: the stream has re-attached (or is about to); a shown pane claims its size again.
  // Only on the way from offline to online: the show above covers a pane that becomes visible.
  const wasOffline = useRef(offline)
  useEffect(() => {
    const back = wasOffline.current && !offline
    wasOffline.current = offline
    if (back && visible) requestAnimationFrame(() => sendV2Size(terminalId))
  }, [visible, offline, terminalId])

  return (
    <div
      className="terminal-pane"
      style={{ display: visible ? 'flex' : 'none' }}
      onMouseDown={() => focusTerminal(terminalId)}
    >
      <div className="terminal-main">
        <div ref={ref} className="terminal-host" />
        {quickButtons && quickButtons.length > 0 && status !== 'exited' && (
          <div className="quick-buttons">
            {quickButtons.map((btn) => (
              <button
                key={btn.id}
                className="quick-btn"
                title={btn.text}
                onClick={() => {
                  const backend = getBackend()
                  backend.sessions
                    .sendPrompt(terminalId, btn.text)
                    .catch((err) => backend.errors.promptFailed('Could not send the prompt', err, btn.text))
                }}
              >
                {btn.label.trim() || btn.text}
              </button>
            ))}
          </div>
        )}
      </div>
      {status !== 'exited' && <QueuePanel terminalId={terminalId} global={global} />}
      {offline && (
        <div className="reconnecting-overlay" role="status">
          <span className="reconnecting-title">{offlineTitle(link)}</span>
          <span className="exited-hint">The session keeps running there. Typing is paused until the connection is back.</span>
        </div>
      )}
      {!offline && status === 'exited' && (
        <div className="exited-overlay">
          <span>Process exited</span>
          <button
            disabled={readOnly !== undefined}
            title={readOnly}
            onClick={() => {
              if (readOnly === undefined) void getBackend().sessions.restart(terminalId)
            }}
          >
            Restart {agentLabel(terminalId)}
          </button>
          {llm && llm.provider !== 'claude' && (
            <span className="exited-hint">
              {serverWindow
                ? `If ${agentLabel(terminalId)} isn't installed on the server, its command is set in the server's config.`
                : `If ${agentLabel(terminalId)} isn't installed, set its command in ⚙ Settings → Agents.`}
            </span>
          )}
        </div>
      )}
    </div>
  )
}
