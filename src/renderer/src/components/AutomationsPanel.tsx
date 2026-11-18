import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Automation } from '../../../shared/model/types'
import { describeCron, formatWall } from '../../../shared/cron'
import { GLOBAL_WORKTREE_ID, useAppStore, type TerminalMeta } from '../store'
import { getBackend } from '../backend'
import { focusTerminal } from '../terminals'
import { tabView } from '../globalTabs'
import {
  SKIPPED_ERROR,
  TRIGGER_LABELS,
  automationRowLine,
  automationState,
  lastRunLabel,
  missedBanner,
  nextRunFact,
  runNowError,
  runningAutomations,
  sortAutomations,
  type AutomationState
} from '../automations'
import { AutomationEditor } from './AutomationEditor'
import { useListDetail } from './useListDetail'

interface Props {
  visible: boolean
}

const NONE: Automation[] = []

const HOW_RUNS_WORK =
  "Each automation has one Global run tab, under the drawer's Automations view: every run starts it afresh with the prompt, and a run is skipped while the last is still working."

/** A state mark's meaning, for a screen reader. */
const STATE_WORDS: Record<AutomationState, string> = {
  missed: 'Missed runs',
  running: 'Running now',
  paused: 'Paused',
  failed: 'Last run failed',
  never: 'Not run yet',
  waiting: 'Last run started'
}

/** Selects a run's tab, opening the Global panel on the tab's view (Automations, unless its automation was deleted). */
function showRun(sessionId: string): void {
  const s = useAppStore.getState()
  s.setGlobalPanelOpen(true)
  s.setGlobalView(tabView(s.terminals[sessionId]))
  s.setActiveTerminal(GLOBAL_WORKTREE_ID, sessionId)
  focusTerminal(sessionId)
}

/** The session of the newest run that ran, while its tab still exists: the only run whose output is kept. */
function openableRun(a: Automation, terminals: Record<string, TerminalMeta>): { index: number; sessionId: string } | null {
  const index = a.history.findIndex((h) => h.outcome === 'ran')
  const sessionId = index >= 0 ? a.history[index].sessionId : undefined
  return sessionId && terminals[sessionId] ? { index, sessionId } : null
}

function StateMark({ state }: { state: AutomationState }): React.JSX.Element {
  return (
    <span className={`automation-mark ${state}`} role="img" aria-label={STATE_WORDS[state]}>
      {state === 'missed' ? '!' : null}
    </span>
  )
}

interface DetailProps {
  a: Automation
  state: AutomationState
  now: number
  offline: boolean
  terminals: Record<string, TerminalMeta>
  onRun: () => void
  onEdit: () => void
}

/** One automation in full: when it runs, how the last run went, its prompt and its history. */
function AutomationDetail({ a, state, now, offline, terminals, onRun, onEdit }: DetailProps): React.JSX.Element {
  const next = nextRunFact(a, now)
  const openable = openableRun(a, terminals)
  const running = state === 'running'
  return (
    <>
      <div className="automation-detail-head">
        <div className="automation-detail-title">
          <h3>{a.name}</h3>
          <span className="muted">
            {describeCron(a.schedule.cron)} · {a.schedule.tz} · <code>{a.schedule.cron}</code>
          </span>
        </div>
        <span className="automation-actions">
          <button disabled={offline || running} title={running ? 'The previous run is still working' : undefined} onClick={onRun}>
            Run now
          </button>
          <button className="automation-edit" disabled={offline} onClick={onEdit}>
            Edit
          </button>
        </span>
      </div>
      <div className="automation-facts-grid">
        <div className="automation-fact">
          <span className="muted">Next run</span>
          <strong>{next.value}</strong>
          {/* Offline, how far off it is cannot be trusted. */}
          {next.sub && !offline && <span className="muted">{next.sub}</span>}
        </div>
        <div className="automation-fact">
          <span className="muted">Last run</span>
          <strong>{lastRunLabel(a).replace(/^Last: /, '')}</strong>
          {openable && openable.index === 0 && (
            <button className="link-button" onClick={() => showRun(openable.sessionId)}>
              Open its tab
            </button>
          )}
        </div>
        <div className="automation-fact">
          <span className="muted">Agent</span>
          <strong>{a.llm ? a.llm.provider : "The project's Global agent"}</strong>
        </div>
      </div>
      <section className="automation-section" aria-label="Prompt">
        <h4>Prompt</h4>
        <p className="automation-prompt">{a.prompt}</p>
      </section>
      <section className="automation-section" aria-label="History">
        <h4>
          History <span className="muted">The last 20 runs. Only the newest run&apos;s output is kept, in its tab.</span>
        </h4>
        {a.history.length === 0 ? (
          <p className="muted">No runs yet.</p>
        ) : (
          <div className="automation-history">
            <table>
              <thead>
                <tr>
                  <th scope="col">When</th>
                  <th scope="col">Started by</th>
                  <th scope="col">Outcome</th>
                </tr>
              </thead>
              <tbody>
                {a.history.map((r, i) => (
                  <tr key={i}>
                    <td>{formatWall(r.at, a.schedule.tz, true)}</td>
                    <td className="muted">{TRIGGER_LABELS[r.trigger]}</td>
                    {r.outcome === 'ran' ? (
                      <td>
                        Ran
                        {openable?.index === i && (
                          <>
                            {' · '}
                            <button className="link-button" onClick={() => showRun(openable.sessionId)}>
                              Open tab
                            </button>
                          </>
                        )}
                      </td>
                    ) : r.outcome === 'skipped' ? (
                      <td className="muted">Skipped · {r.error ?? SKIPPED_ERROR}</td>
                    ) : (
                      <td className="error-text">Failed · {r.error ?? 'unknown error'}</td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  )
}

/**
 * The project's automations: a list (a state mark, a line and a switch each) and the selected one
 * in full beside it. Each owns one Global run tab, renewed with the automation's prompt on every
 * run. The editor opens in the detail's place; the list waits, inert, until it is saved or cancelled.
 */
export function AutomationsPanel({ visible }: Props): React.JSX.Element {
  const automations = useAppStore((s) => s.project?.automations ?? NONE)
  const terminals = useAppStore((s) => s.terminals)
  const offline = useAppStore((s) => s.serverOffline)
  const [editing, setEditing] = useState<string | 'new' | null>(null)
  const [chosen, setChosen] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // The rows count down to their next run: once a minute while the page shows.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!visible) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(timer)
  }, [visible])

  const rows = sortAutomations(automations)
  const running = runningAutomations(terminals)
  const selected = rows.find((a) => a.id === chosen) ?? rows[0]
  const pane = useListDetail({ hasSelection: selected !== undefined || editing === 'new', scroller: '.automations-panel', selectedRow: '.ld-row.selected .ld-row-main' })
  const paused = automations.filter((a) => !a.enabled).length
  const banner = missedBanner(automations)

  const act = async (fn: () => Promise<unknown>, explain?: (err: unknown) => string | undefined): Promise<void> => {
    setError(null)
    const backend = getBackend()
    try {
      await fn()
    } catch (err) {
      setError(explain?.(err) ?? backend.errors.inline(err))
    }
  }
  const toggle = (a: Automation): Promise<void> => {
    // Pausing a row moves it after the rest: the automation that only shows as the first row is
    // chosen first, so the detail stays on it.
    if (selected && selected.id !== chosen) setChosen(selected.id)
    return act(() => getBackend().automations.save({ id: a.id, name: a.name, prompt: a.prompt, schedule: a.schedule, enabled: !a.enabled, llm: a.llm ?? null }))
  }
  // A busy run tab (its last run still working) refuses with CONFLICT: the run is skipped.
  const runNow = (a: Automation): Promise<void> => act(async () => showRun(await getBackend().automations.runNow(a.id)), runNowError)

  const choose = (id: string): void => {
    setChosen(id)
    pane.open()
  }
  const startEditing = (which: string | 'new'): void => {
    setError(null)
    setEditing(which)
    // A narrow page shows the editor where the detail goes.
    pane.open()
  }
  const doneEditing = (result?: { saved?: string; deleted?: true }): void => {
    if (result?.saved) setChosen(result.saved)
    // A new automation had no detail to return to, and a deleted one has none left: a narrow page
    // goes back to the list. Otherwise it stays on the automation's detail.
    if (editing === 'new' || result?.deleted) pane.back()
    setEditing(null)
  }

  const editingAutomation = editing && editing !== 'new' ? automations.find((a) => a.id === editing) : undefined
  const deletedElsewhere = !!editing && editing !== 'new' && !editingAutomation
  // Another window deleted it: close the editor rather than let Save create a duplicate.
  useEffect(() => {
    if (deletedElsewhere) {
      setEditing(null)
      setError('That automation was deleted')
    }
  }, [deletedElsewhere])
  const editorOpen = !!editing && !deletedElsewhere
  const empty = automations.length === 0 && !editorOpen

  // Closing the editor unmounts the button that had the focus, which would drop it to the page:
  // it goes to the detail's Edit, or to the selected row where a narrow page shows the list.
  const { root } = pane
  const wasEditing = useRef(false)
  useLayoutEffect(() => {
    const closed = wasEditing.current && !editorOpen
    wasEditing.current = editorOpen
    if (!closed) return
    const edit = root.current?.querySelector<HTMLElement>('.automation-edit')
    // No boxes: the detail is the pane a narrow page hides.
    const target = edit && edit.getClientRects().length > 0 ? edit : root.current?.querySelector<HTMLElement>('.ld-row.selected .ld-row-main')
    target?.focus({ preventScroll: true })
  }, [editorOpen, root])

  return (
    <div className="automations-panel list-detail-host" style={{ display: visible ? 'flex' : 'none' }}>
      <div className="automations-header">
        <h2>Automations</h2>
        {automations.length > 0 && (
          <span className="muted" title={HOW_RUNS_WORK}>
            {automations.length} automation{automations.length === 1 ? '' : 's'}
            {paused > 0 ? ` · ${paused} paused` : ''}
          </span>
        )}
        {!empty && (
          <button className="primary primary-action" disabled={offline || editorOpen} onClick={() => startEditing('new')}>
            New automation
          </button>
        )}
      </div>
      {offline && <div className="automations-offline muted">Not connected. Automations still run on the server.</div>}
      {banner && (
        <div className="automations-missed" role="status">
          <span>{banner}</span>
          <button onClick={() => useAppStore.getState().setMissedDismissedKey(null)}>Review missed runs</button>
        </div>
      )}
      {error && <div className="error">{error}</div>}
      {empty ? (
        <div className="automations-empty">
          <strong>Send a prompt to an agent on a schedule</strong>
          <span className="muted">{HOW_RUNS_WORK}</span>
          <button className="primary primary-action" disabled={offline} onClick={() => startEditing('new')}>
            New automation
          </button>
        </div>
      ) : (
        // The editor is in the detail pane, so a narrow page shows that pane while it is open, whether
        // or not a row was opened first (with no automations there was no list to open one from).
        <div className={`list-detail automations-body${pane.showDetail || editorOpen ? ' detail-open' : ''}`} ref={pane.root}>
          {/* While the editor is open the list waits: Save or Cancel leaves it. */}
          <nav className={`list-detail-list automations-list${editorOpen ? ' waiting' : ''}`} aria-label="Automations" inert={editorOpen}>
            {editing === 'new' && (
              <div className="ld-row selected">
                <span className="ld-row-main">
                  <span className="automation-mark never" aria-hidden="true" />
                  <span className="ld-row-text">
                    <span className="ld-row-name">New automation</span>
                    <span className="ld-row-line">Not saved yet</span>
                  </span>
                </span>
              </div>
            )}
            {rows.map((a) => {
              const state = automationState(a, running.has(a.id))
              const line = automationRowLine(a, state, now, offline)
              const isSelected = editing !== 'new' && a.id === selected?.id
              return (
                <div key={a.id} className={`ld-row automation-row${isSelected ? ' selected' : ''}${state === 'paused' ? ' dim' : ''}`} data-automation={a.id}>
                  <button type="button" className="ld-row-main" aria-current={isSelected ? 'true' : undefined} onClick={() => choose(a.id)}>
                    <StateMark state={state} />
                    <span className="ld-row-text">
                      <span className="ld-row-name">{a.name}</span>
                      <span className={`ld-row-line automation-line ${line.tone}`}>{line.text}</span>
                    </span>
                  </button>
                  <input type="checkbox" role="switch" className="plugin-switch" aria-label={`${a.name} enabled`} checked={a.enabled} disabled={offline} onChange={() => void toggle(a)} />
                  <span className="list-detail-chevron" aria-hidden="true">
                    ›
                  </span>
                </div>
              )
            })}
            <p className="muted automations-how">{HOW_RUNS_WORK}</p>
          </nav>
          <section className="list-detail-detail automation-detail" aria-label={editorOpen ? 'Automation editor' : selected?.name}>
            {editorOpen ? (
              <AutomationEditor key={editing} automation={editingAutomation} onDone={doneEditing} />
            ) : (
              selected && (
                <>
                  <button type="button" className="list-detail-back" ref={pane.backButton} onClick={pane.back}>
                    ‹ Automations
                  </button>
                  <AutomationDetail
                    a={selected}
                    state={automationState(selected, running.has(selected.id))}
                    now={now}
                    offline={offline}
                    terminals={terminals}
                    onRun={() => void runNow(selected)}
                    onEdit={() => startEditing(selected.id)}
                  />
                </>
              )
            )}
          </section>
        </div>
      )}
    </div>
  )
}
