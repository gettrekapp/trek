import { useEffect, useRef } from 'react'
import { useAppStore } from '../store'
import { agentLabel, attachTerminal, fitTerminal, focusTerminal } from '../terminals'
import { getBackend } from '../backend'
import { QueuePanel } from './QueuePanel'

interface Props {
  terminalId: string
  visible: boolean
  /** Shows the global Claude quick buttons instead of the worktree ones */
  global?: boolean
}

export function TerminalPane({ terminalId, visible, global = false }: Props): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const status = useAppStore((s) => s.terminals[terminalId]?.status)
  // Subscribed so the restart label follows the session's agent.
  const llm = useAppStore((s) => s.terminals[terminalId]?.llm)
  const quickButtons = useAppStore((s) =>
    global ? s.project?.globalTerminalButtons : s.project?.terminalButtons
  )

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
        fitTerminal(terminalId)
        focusTerminal(terminalId)
      })
    }
  }, [visible, terminalId])

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
                onClick={() => void getBackend().sessions.sendPrompt(terminalId, btn.text)}
              >
                {btn.label.trim() || btn.text}
              </button>
            ))}
          </div>
        )}
      </div>
      {status !== 'exited' && <QueuePanel terminalId={terminalId} global={global} />}
      {status === 'exited' && (
        <div className="exited-overlay">
          <span>Process exited</span>
          <button onClick={() => void getBackend().sessions.restart(terminalId)}>
            Restart {agentLabel(terminalId)}
          </button>
          {llm && llm.provider !== 'claude' && (
            <span className="exited-hint">
              If {agentLabel(terminalId)} isn&apos;t installed, set its command in ⚙ Settings → Agents.
            </span>
          )}
        </div>
      )}
    </div>
  )
}
