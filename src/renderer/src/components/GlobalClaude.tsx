import { useEffect, useState } from 'react'
import { BOT_DECISION_ID, GLOBAL_WORKTREE_ID, useAppStore } from '../store'
import {
  closeGlobalTerminal,
  cycleTab,
  focusInGlobalPanel,
  focusTerminal,
  openGlobalTerminals,
  saveGlobalSessions,
  startGlobalTerminal,
  tabCycleStep
} from '../terminals'
import { globalSessionLlm } from '../llm'
import { getProvider } from '../../../shared/providers/registry'
import { describeLlm } from '../../../shared/providers/selection'
import { BotPanel } from './BotPanel'
import { StatusBadge } from './StatusBadge'
import { DecisionIcon } from './DecisionIcon'
import { TerminalPane } from './TerminalPane'

const HEIGHT_KEY = 'globalClaudeHeight'
const DEFAULT_HEIGHT = 320
const MIN_HEIGHT = 140
/** Room always left above the panel for the workspace. */
const MIN_WORKSPACE = 200

function clampHeight(height: number): number {
  return Math.max(MIN_HEIGHT, Math.min(height, window.innerHeight - MIN_WORKSPACE))
}

function storedHeight(): number {
  try {
    const value = Number(localStorage.getItem(HEIGHT_KEY))
    return value > 0 ? clampHeight(value) : DEFAULT_HEIGHT
  } catch {
    return DEFAULT_HEIGHT
  }
}

const NO_TABS: string[] = []

/**
 * Project-wide agent sessions, as tabs in a collapsible panel docked to the
 * bottom of the window. They run in the repository root with the app's MCP
 * server, so they can drive the worktree sessions. Started on first open,
 * then kept alive while collapsed. (Named from when every session was Claude.)
 */
export function GlobalClaude(): React.JSX.Element {
  const open = useAppStore((s) => s.globalPanelOpen)
  const view = useAppStore((s) => s.globalView)
  const order = useAppStore((s) => s.terminalOrder[GLOBAL_WORKTREE_ID] ?? NO_TABS)
  const activeId = useAppStore((s) => s.activeTerminal[GLOBAL_WORKTREE_ID])
  const terminals = useAppStore((s) => s.terminals)
  const decisions = useAppStore((s) => s.decisions)
  const decisionCount = order.filter((id) => decisions[id]).length + (decisions[BOT_DECISION_ID] ? 1 : 0)
  const botView = useAppStore((s) => s.botView)
  // Subscribed so the bar label follows the configured Global agent.
  useAppStore((s) => s.project?.globalLlm)
  useAppStore((s) => s.project?.llmDefault)
  useAppStore((s) => s.llmSettings)
  const [height, setHeight] = useState(storedHeight)
  const [error, setError] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const hasTabs = order.length > 0
  const attention = order.some((id) => terminals[id]?.status === 'attention')
  const status = attention ? 'attention' : activeId ? terminals[activeId]?.status : undefined

  useEffect(() => {
    if (!open || hasTabs || view === 'bot') return
    setError(null)
    openGlobalTerminals().catch((err) => setError(String(err)))
  }, [open, hasTabs, view])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      const step = tabCycleStep(e)
      if (!step || !focusInGlobalPanel()) return
      e.preventDefault()
      e.stopPropagation()
      if (useAppStore.getState().globalView === 'sessions') cycleTab(GLOBAL_WORKTREE_ID, step)
    }
    // Capture phase, so the focused xterm never sees the keystroke.
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [])

  const toggle = (): void => useAppStore.getState().setGlobalPanelOpen(!open)

  const newTab = (): void => {
    const viewChanged = view !== 'sessions'
    useAppStore.getState().setGlobalView('sessions')
    if (!hasTabs && viewChanged) return // the effect above opens the first session on this change of view
    setError(null)
    startGlobalTerminal().catch((err) => setError(String(err)))
  }

  const selectTab = (id: string): void => {
    useAppStore.getState().setGlobalView('sessions')
    useAppStore.getState().setActiveTerminal(GLOBAL_WORKTREE_ID, id)
    focusTerminal(id)
  }

  const startRename = (id: string): void => {
    setEditingId(id)
    setDraft(terminals[id]?.title ?? '')
  }

  const commitRename = (): void => {
    if (editingId) {
      useAppStore.getState().renameTerminal(editingId, draft)
      saveGlobalSessions()
    }
    setEditingId(null)
  }

  const startResize = (e: React.MouseEvent): void => {
    e.preventDefault()
    const startY = e.clientY
    const startHeight = height
    let latest = startHeight
    const onMove = (ev: MouseEvent): void => {
      latest = clampHeight(startHeight + startY - ev.clientY)
      setHeight(latest)
    }
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.classList.remove('resizing-row')
      try {
        localStorage.setItem(HEIGHT_KEY, String(latest))
      } catch {
        // height just won't be remembered
      }
    }
    document.body.classList.add('resizing-row')
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  return (
    <div className="global-claude">
      <div className="global-panel" style={{ height, display: open ? 'flex' : 'none' }}>
        <div className="global-resize" onMouseDown={startResize} />
        <div className="global-tabs">
          {order.map((id) => {
            const meta = terminals[id]
            if (!meta) return null
            const isActive = id === activeId
            return (
              <div
                key={id}
                className={`global-tab ${isActive && view === 'sessions' ? 'active' : ''} status-${meta.status} ${
                  decisions[id] ? 'has-decision' : ''
                }`}
                onClick={() => selectTab(id)}
                onDoubleClick={() => startRename(id)}
                onMouseDown={(e) => {
                  if (e.button === 1) e.preventDefault()
                }}
                onAuxClick={(e) => {
                  if (e.button === 1) closeGlobalTerminal(id)
                }}
                title="Double-click to rename"
              >
                <StatusBadge status={meta.status} />
                <DecisionIcon terminalId={id} />
                {editingId === id ? (
                  <input
                    className="tab-title-input"
                    value={draft}
                    autoFocus
                    onChange={(e) => setDraft(e.target.value)}
                    onBlur={commitRename}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') commitRename()
                      if (e.key === 'Escape') setEditingId(null)
                    }}
                    onMouseDown={(e) => e.stopPropagation()}
                  />
                ) : (
                  <>
                    {meta.llm && meta.llm.provider !== 'claude' && (
                      <span className="session-llm-glyph" title={describeLlm(meta.llm)}>
                        {getProvider(meta.llm.provider).glyph}
                      </span>
                    )}
                    <span className="global-tab-title">{meta.title}</span>
                  </>
                )}
                <span
                  className="session-tab-close"
                  title="Close tab"
                  onClick={(e) => {
                    e.stopPropagation()
                    closeGlobalTerminal(id)
                  }}
                >
                  ×
                </span>
              </div>
            )
          })}
          <div
            className={`global-tab bot-tab ${view === 'bot' ? 'active' : ''} ${
              decisions[BOT_DECISION_ID] ? 'has-decision' : ''
            }`}
            onClick={() => useAppStore.getState().setGlobalView('bot')}
          >
            <DecisionIcon terminalId={BOT_DECISION_ID} />
            <span className="global-tab-title">Bot</span>
          </div>
          <button className="global-tab-add" onClick={newTab} title="New Global tab">
            +
          </button>
        </div>
        <div className="global-terminal" style={{ display: view === 'sessions' ? undefined : 'none' }}>
          {order.map((id) => (
            <TerminalPane key={id} terminalId={id} visible={open && view === 'sessions' && id === activeId} global />
          ))}
          {error && <div className="global-error">Couldn't start the session: {error}</div>}
        </div>
        <BotPanel visible={view === 'bot'} />
      </div>
      <div
        className={`global-bar ${open ? 'open' : ''} ${attention ? 'attention' : ''}`}
        onClick={toggle}
        title={open ? 'Hide the Global panel (⌘J)' : 'Show the Global panel (⌘J)'}
      >
        <span className="global-chevron">{open ? '▾' : '▴'}</span>
        <span className="global-title">Global · {getProvider(globalSessionLlm().provider).label}</span>
        <StatusBadge status={status ?? null} />
        {decisionCount > 0 && (
          <span className="decision-icon" title={`${decisionCount} global session(s) or the project bot need a decision`}>
            ⚑
          </span>
        )}
        <span className="global-hint">
          {hasTabs
            ? `project-wide ${order.length === 1 ? 'session' : `sessions (${order.length})`} · controls worktree sessions`
            : botView.needsConsent
              ? 'bot: waiting for your OK'
              : botView.phase !== 'off'
                ? `bot: ${botView.phase}`
                : 'click to start a project-wide session'}
        </span>
      </div>
    </div>
  )
}
