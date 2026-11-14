import { useState } from 'react'
import type { Automation } from '../../../shared/model/types'
import { describeCron, formatWall } from '../../../shared/cron'
import { GLOBAL_WORKTREE_ID, useAppStore } from '../store'
import { getBackend } from '../backend'
import { focusTerminal } from '../terminals'
import { lastRunLabel, missedLabel, nextRunLabel } from '../automations'
import { AutomationEditor } from './AutomationEditor'

interface Props {
  visible: boolean
}

const NONE: Automation[] = []

/** Selects a run's Global tab, opening the Global panel. */
function showRun(sessionId: string): void {
  const s = useAppStore.getState()
  s.setGlobalPanelOpen(true)
  s.setGlobalView('sessions')
  s.setActiveTerminal(GLOBAL_WORKTREE_ID, sessionId)
  focusTerminal(sessionId)
}

/** The project's automations: each run is a new Global tab with the automation's prompt. */
export function AutomationsPanel({ visible }: Props): React.JSX.Element {
  const automations = useAppStore((s) => s.project?.automations ?? NONE)
  const terminals = useAppStore((s) => s.terminals)
  const offline = useAppStore((s) => s.serverOffline)
  const [editing, setEditing] = useState<string | 'new' | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const now = Date.now()

  const act = async (fn: () => Promise<unknown>): Promise<void> => {
    setError(null)
    const backend = getBackend()
    try {
      await fn()
    } catch (err) {
      setError(backend.errors.inline(err))
    }
  }
  const toggle = (a: Automation): Promise<void> =>
    act(() => getBackend().automations.save({ id: a.id, name: a.name, prompt: a.prompt, schedule: a.schedule, enabled: !a.enabled, llm: a.llm ?? null }))
  const runNow = (a: Automation): Promise<void> => act(async () => showRun(await getBackend().automations.runNow(a.id)))

  const editingAutomation = editing && editing !== 'new' ? automations.find((a) => a.id === editing) : undefined
  return (
    <div className="automations-panel settings-panel" style={{ display: visible ? 'flex' : 'none' }}>
      {editing ? (
        <AutomationEditor key={editing} automation={editingAutomation} onDone={() => setEditing(null)} />
      ) : (
        <>
          <div className="automations-header">
            <h2>Automations</h2>
            <span className="muted">Each run opens a new Global tab with the automation&apos;s prompt.</span>
            <button className="primary primary-action" disabled={offline} onClick={() => setEditing('new')}>
              New automation
            </button>
          </div>
          {error && <div className="error">{error}</div>}
          {automations.length === 0 && <p className="muted">No automations yet.</p>}
          {automations.map((a) => (
            <div key={a.id} className={`automation-row ${a.enabled ? '' : 'paused'}`}>
              <div className="automation-main">
                <input type="checkbox" title={a.enabled ? 'Enabled' : 'Paused'} checked={a.enabled} disabled={offline} onChange={() => void toggle(a)} />
                <span className="automation-name">{a.name}</span>
                <span className="automation-schedule">{describeCron(a.schedule.cron)}</span>
                <span className="muted">{nextRunLabel(a, now)}</span>
                <span className="muted">{lastRunLabel(a)}</span>
                {a.missed && (
                  <button className="automation-missed" onClick={() => useAppStore.getState().setMissedDismissedKey(null)}>
                    {missedLabel(a.missed, a.schedule.tz)}
                  </button>
                )}
                <span className="spacer" />
                <button disabled={offline} onClick={() => void runNow(a)}>Run now</button>
                <button disabled={offline} onClick={() => setEditing(a.id)}>Edit</button>
                <button onClick={() => setExpanded(expanded === a.id ? null : a.id)}>{expanded === a.id ? 'Hide history' : 'History'}</button>
              </div>
              {expanded === a.id && (
                <ul className="automation-history">
                  {a.history.length === 0 && <li className="muted">No runs yet.</li>}
                  {a.history.map((r, i) => (
                    <li key={i}>
                      <span>{formatWall(r.at, a.schedule.tz, true)}</span>
                      <span className="muted">{r.trigger}</span>
                      {r.outcome === 'ran' ? (
                        r.sessionId && terminals[r.sessionId] ? (
                          <button className="link-button" onClick={() => showRun(r.sessionId as string)}>open tab</button>
                        ) : (
                          <span>ran</span>
                        )
                      ) : (
                        <span className="error-text">failed: {r.error}</span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </>
      )}
    </div>
  )
}
