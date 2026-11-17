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
  isQuietReveal,
  foreignSize,
  sendV2Size,
  subscribeForeignSize
} from '../terminals'
import { getBackend } from '../backend'
import { QueueChip, QueuePanel } from './QueuePanel'
import { moreLabel, moveButton, overflowCount, splitOverflow } from '../quickButtonRow'
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
    // After the key event that sent it (a modal's Enter), or xterm gets that Enter too
    requestAnimationFrame(() => focusTerminal(terminalId))
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
  // The quick buttons' row: how many wrapped out of sight (they go behind More), read back from the layout.
  const buttons = quickButtons ?? []
  const listRef = useRef<HTMLDivElement>(null)
  const [hidden, setHidden] = useState(0)
  const [moreOpen, setMoreOpen] = useState(false)
  useEffect(() => {
    const list = listRef.current
    if (!list) return
    const measure = (): void => setHidden(overflowCount([...list.children].map((el) => (el as HTMLElement).offsetTop)))
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(list)
    return () => observer.disconnect()
  }, [quickButtons, visible, status])
  useEffect(() => {
    if (hidden === 0 || !visible) setMoreOpen(false)
  }, [hidden, visible])
  const overflow = splitOverflow(buttons, hidden)
  // Drag to sort: on the row (left/right halves) and in the More menu (top/bottom halves).
  const [dragId, setDragId] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<{ id: string; side: 'before' | 'after' } | null>(null)
  const endDrag = (): void => {
    setDragId(null)
    setDropTarget(null)
  }
  const dragProps = (id: string, axis: 'x' | 'y'): React.HTMLAttributes<HTMLDivElement> & { draggable: boolean } => ({
    draggable: true,
    onDragStart: (e) => {
      e.dataTransfer.effectAllowed = 'move'
      e.dataTransfer.setData('application/x-trek-quick-button', id)
      setDragId(id)
    },
    onDragOver: (e) => {
      if (!dragId) return
      e.preventDefault()
      const rect = e.currentTarget.getBoundingClientRect()
      const after = axis === 'x' ? e.clientX > rect.left + rect.width / 2 : e.clientY > rect.top + rect.height / 2
      const side = after ? 'after' : 'before'
      if (dropTarget?.id !== id || dropTarget.side !== side) setDropTarget({ id, side })
    },
    onDrop: (e) => {
      e.preventDefault()
      if (dragId && dropTarget?.id === id) {
        const next = moveButton(buttons, dragId, id, dropTarget.side)
        if (next !== buttons) setButtons(next)
      }
      endDrag()
    },
    onDragEnd: endDrag
  })
  const dragClass = (id: string): string =>
    `${dragId === id ? ' dragging' : ''}${dropTarget?.id === id && dragId !== id ? ` drop-${dropTarget.side}` : ''}`
  /** One button in the More menu: run it, or edit it. */
  const moreRow = (btn: TerminalQuickButton): React.JSX.Element => {
    const label = btn.label.trim() || btn.text
    return (
      <div key={btn.id} className={`quick-more-item${dragClass(btn.id)}`} {...dragProps(btn.id, 'y')}>
        <button
          className="quick-more-run"
          title={btn.text}
          onClick={() => {
            setMoreOpen(false)
            run(btn)
          }}
        >
          {label}
          {templateInputs(btn.text).length > 0 ? '…' : ''}
        </button>
        <button
          className="quick-more-edit"
          aria-label={`Edit ${label}`}
          onClick={() => {
            setMoreOpen(false)
            setEditing(btn)
          }}
        >
          Edit
        </button>
      </div>
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
        // Shown for an agent's focus_session: the user's caret and the session's attention stay as they are.
        if (!isQuietReveal(terminalId)) focusTerminal(terminalId)
      })
    }
  }, [visible, terminalId])

  // A hidden pane leaves no modal behind (they render outside the pane, so would stay shown).
  useEffect(() => {
    if (!visible) {
      setEditing(null)
      setRunning(null)
      endDrag()
    }
  }, [visible])

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
              {/* One row: the buttons wrap and everything below the first line is clipped, so what fits shows */}
              <div className="quick-btn-list" ref={listRef}>
                {buttons.map((btn) => {
                  const label = btn.label.trim() || btn.text
                  return (
                    <div key={btn.id} className={`quick-btn${dragClass(btn.id)}`} {...dragProps(btn.id, 'x')}>
                      <button
                        className="quick-btn-main"
                        title={`${btn.text}\n\nDrag to sort · right-click to edit`}
                        onClick={() => run(btn)}
                        onContextMenu={(e) => {
                          e.preventDefault()
                          setEditing(btn)
                        }}
                      >
                        <span className="quick-btn-label">{label}</span>
                        {templateInputs(btn.text).length > 0 && (
                          <span className="quick-btn-input-icon" title="Asks for input">
                            …
                          </span>
                        )}
                      </button>
                      <button
                        className="quick-btn-edit"
                        title="Edit"
                        aria-label={`Edit ${label}`}
                        draggable={false}
                        onClick={() => setEditing(btn)}
                      >
                        ✎
                      </button>
                    </div>
                  )
                })}
              </div>
              {hidden > 0 && (
                <div className="quick-more">
                  <button
                    className="quick-more-btn"
                    title="The quick buttons that do not fit on the row"
                    aria-expanded={moreOpen}
                    onClick={() => setMoreOpen((v) => !v)}
                  >
                    {moreLabel(hidden)} <span className="chip-caret">▴</span>
                  </button>
                  {moreOpen && (
                    <>
                      <div className="detail-menu-backdrop" onClick={() => setMoreOpen(false)} />
                      <div className="quick-more-menu">
                        {overflow.more.map(moreRow)}
                        {overflow.shown.length > 0 && (
                          <>
                            <div className="detail-menu-divider" />
                            <div className="quick-more-heading">On the row</div>
                            {overflow.shown.map(moreRow)}
                          </>
                        )}
                        <div className="detail-menu-divider" />
                        <div className="quick-more-item">
                          <button
                            className="quick-more-run quiet"
                            onClick={() => {
                              setMoreOpen(false)
                              setEditing('new')
                            }}
                          >
                            New quick button…
                          </button>
                        </div>
                      </div>
                    </>
                  )}
                </div>
              )}
              <button className="quick-btn-add" title="Add quick button" onClick={() => setEditing('new')}>
                {buttons.length === 0 ? 'Add a quick button' : '+'}
              </button>
              <span className="quick-buttons-spacer" />
              <QueueChip terminalId={terminalId} global={global} />
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
          onClose={() => {
            setEditing(null)
            requestAnimationFrame(() => focusTerminal(terminalId))
          }}
        />
      )}
      {running && (
        <QuickButtonRunModal
          button={running.button}
          plan={running.plan}
          builtins={running.builtins}
          onSend={send}
          onClose={() => {
            setRunning(null)
            requestAnimationFrame(() => focusTerminal(terminalId))
          }}
        />
      )}
    </>
  )
}
