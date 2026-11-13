import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { TerminalQuickButton } from '../../../shared/types'
import {
  fillTemplate,
  parseTemplate,
  planQuickButton,
  resolveBuiltins,
  templateInputs,
  type BuiltinValues,
  type QuickButtonPlan
} from '../../../shared/quickButtonTemplate.ts'
import { quickButtonContext } from '../quickButtonContext'
import { QuickButtonModal } from './QuickButtonModal'
import { QuickButtonRunModal } from './QuickButtonRunModal'
import { useAppStore } from '../store'
import {
  agentLabel,
  attachTerminal,
  fitTerminal,
  focusTerminal,
  foreignSize,
  sendV2Size,
  subscribeForeignSize
} from '../terminals'
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

/** The final text of a button that needs no modal: its built-ins all resolved. */
function fillTemplateNow(text: string, builtins: BuiltinValues): string {
  return fillTemplate(parseTemplate(text), {}, builtins)
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
  const setButtons = useAppStore((s) => (global ? s.setGlobalTerminalButtons : s.setTerminalButtons))
  /** The button in the edit modal; 'new' = creating one */
  const [editing, setEditing] = useState<TerminalQuickButton | 'new' | null>(null)
  const [running, setRunning] = useState<{
    button: TerminalQuickButton
    plan: QuickButtonPlan
    builtins: BuiltinValues
  } | null>(null)

  const send = (text: string): void => {
    const backend = getBackend()
    backend.sessions
      .sendPrompt(terminalId, text)
      .catch((err) => backend.errors.promptFailed('Could not send the prompt', err, text))
    focusTerminal(terminalId)
  }
  const run = (button: TerminalQuickButton): void => {
    const ctx = quickButtonContext(terminalId)
    const builtins = ctx ? resolveBuiltins(ctx) : {}
    const plan = planQuickButton(button.text, builtins)
    if (plan.needsModal) setRunning({ button, plan, builtins })
    else send(fillTemplateNow(button.text, builtins))
  }
  const saveButton = (button: TerminalQuickButton): void => {
    const list = quickButtons ?? []
    setButtons(
      list.some((b) => b.id === button.id) ? list.map((b) => (b.id === button.id ? button : b)) : [...list, button]
    )
  }
  // A server window whose link is down: input would be dropped, so the pane is covered.
  const offline = useAppStore((s) => s.serverOffline)
  const link = useAppStore((s) => s.serverLink)
  // Another window (e.g. Trek on the server's machine) sized the pty: this xterm follows it.
  const foreign = useSyncExternalStore(
    subscribeForeignSize,
    useCallback(() => foreignSize(terminalId), [terminalId])
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
    <>
      <div
        className="terminal-pane"
        style={{ display: visible ? 'flex' : 'none' }}
        onMouseDown={() => focusTerminal(terminalId)}
      >
        <div className="terminal-main">
          {foreign && !offline && (
            <div className="terminal-size-bar" role="status">
              <span>
                Sized for another window ({foreign.cols}×{foreign.rows})
              </span>
              <button
                onMouseDown={(e) => e.stopPropagation()}
                onClick={() => {
                  sendV2Size(terminalId)
                  focusTerminal(terminalId)
                }}
              >
                Fit to this window
              </button>
            </div>
          )}
          <div ref={ref} className="terminal-host" />
          {status !== 'exited' && (
            <div className="quick-buttons">
              {(quickButtons ?? []).map((btn) => {
                const label = btn.label.trim() || btn.text
                return (
                  <div key={btn.id} className="quick-btn">
                    <button className="quick-btn-main" title={btn.text} onClick={() => run(btn)}>
                      {templateInputs(btn.text).length > 0 && (
                        <span className="quick-btn-input-icon" title="Asks for input">
                          ⌨
                        </span>
                      )}
                      <span className="quick-btn-label">{label}</span>
                    </button>
                    <button
                      className="quick-btn-edit"
                      title="Edit button"
                      aria-label={`Edit ${label}`}
                      onClick={() => setEditing(btn)}
                    >
                      ✎
                    </button>
                  </div>
                )
              })}
              <button className="quick-btn-add" title="Add quick button" onClick={() => setEditing('new')}>
                +
              </button>
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
                {`If ${agentLabel(terminalId)} isn't installed on the server, its command is set in the server's config.`}
              </span>
            )}
          </div>
        )}
      </div>
      {editing && (
        <QuickButtonModal
          button={editing === 'new' ? undefined : editing}
          onSave={saveButton}
          onDelete={
            editing === 'new'
              ? undefined
              : () => setButtons((quickButtons ?? []).filter((b) => b.id !== editing.id))
          }
          onClose={() => setEditing(null)}
        />
      )}
      {running && (
        <QuickButtonRunModal
          button={running.button}
          plan={running.plan}
          builtins={running.builtins}
          onSend={send}
          onClose={() => setRunning(null)}
        />
      )}
    </>
  )
}
