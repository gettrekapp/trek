// The camp popover's Trails tab (campsite part 3c): this window's project's trails (each a row: its
// flag's colour, its branch, a five-dot stage meter, its stage and how long it has been there), then
// its history (asked for when the tab opens: the snapshot doesn't carry it); with the trail signpost,
// every other project's trails, each with a "Show history" button; without it, a dimmed line saying
// what the signpost adds. Opened at a trail (a flag clicked), that row takes the focus (the selected
// tab when its row is gone). This project's history is asked for again when its open trails change
// (one ending shows in it); only the newest answer for a project is kept. After "Show history" or
// Retry, the history's region takes the focus (the button is gone).
import { useEffect, useId, useRef, useState } from 'react'
import type { CampSnapshot, TrailEntry } from '../shared/camp.ts'
import { NO_TRAILS, SIGNPOST_HINT, historyText, meterLabel, trailGroups, trailStatus } from '../shared/campView.ts'
import { tentColors } from '../shared/layout.ts'
import { STAGES, type TrailRecord } from '../shared/trails.ts'
import type { CampStore } from './campStore.ts'
import { useNow } from './hooks.ts'

interface Props {
  camp: CampSnapshot
  /** The window's project */
  projectId: string
  store: Pick<CampStore, 'trailLog'>
  /** A trail of this project to show (its worktree's id), else null */
  focus: string | null
}

type History = { state: 'loading' } | { state: 'failed' } | { state: 'ready'; log: TrailRecord[] }

export function TrailsTab({ camp, projectId, store, focus }: Props): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const ids = useId()
  const now = useNow()
  // Each project's history, once asked for (this project's when the tab opens)
  const [histories, setHistories] = useState<Record<string, History>>({})
  const alive = useRef(true)
  // Each project's latest request: an older answer is dropped
  const asked = useRef(new Map<string, number>())
  // A history region to focus once it renders (after Show history or Retry)
  const focusHistory = useRef<string | null>(null)
  /** Asks for a project's history; `quiet` (asked again): a list already shown stays until the answer, and stays if it fails */
  const load = (id: string, quiet = false): void => {
    const token = (asked.current.get(id) ?? 0) + 1
    asked.current.set(id, token)
    const latest = (): boolean => alive.current && asked.current.get(id) === token
    setHistories((h) => (quiet && h[id]?.state === 'ready' ? h : { ...h, [id]: { state: 'loading' } }))
    store.trailLog(id).then(
      ({ log }) => {
        if (latest()) setHistories((h) => ({ ...h, [id]: { state: 'ready', log } }))
      },
      () => {
        if (latest()) setHistories((h) => (quiet && h[id]?.state === 'ready' ? h : { ...h, [id]: { state: 'failed' } }))
      }
    )
  }
  /** Show history or Retry: load, and the history's region takes the focus (the pressed button goes) */
  const ask = (id: string): void => {
    focusHistory.current = id
    load(id)
  }
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  const { here, others } = trailGroups(camp.trails ?? [], projectId)
  // This project's open trails as a string: when one ends (or starts), its history is asked for again
  const hereKey = here
    .map((t) => `${t.worktreeId}:${t.branch}`)
    .sort()
    .join('\n')
  const first = useRef(true)
  useEffect(() => {
    load(projectId, !first.current)
    first.current = false
  }, [hereKey])
  useEffect(() => {
    const id = focusHistory.current
    if (id === null) return
    focusHistory.current = null
    ref.current?.querySelector<HTMLElement>(`[data-history="${CSS.escape(id)}"]`)?.focus()
  }, [histories])
  useEffect(() => {
    if (focus === null) return
    const row = ref.current?.querySelector<HTMLElement>(`[data-trail="${CSS.escape(focus)}"]`)
    // Its trail ended before the popover opened: the selected tab instead of nothing (the body)
    if (!row) {
      ref.current?.closest('.cs-camp-popover')?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus()
      return
    }
    row.scrollIntoView({ block: 'nearest' })
    row.focus()
  }, [])
  return (
    <div ref={ref} className="cs-trails">
      <div className="cs-crew-heading">{here[0]?.projectName ?? 'This project'}</div>
      {here.length === 0 && <div className="cs-crew-empty">{NO_TRAILS}</div>}
      {here.map((t) => (
        <TrailRow key={t.worktreeId} trail={t} now={now} focusable />
      ))}
      <div className="cs-crew-heading" id={`${ids}-history`}>
        History
      </div>
      <div className="cs-trails-history" data-history={projectId} tabIndex={-1} role="region" aria-labelledby={`${ids}-history`}>
        <HistoryList history={histories[projectId]} now={now} onRetry={() => ask(projectId)} />
      </div>
      {(camp.built.signpost ?? 0) >= 1 ? (
        others.map((g) => (
          <div key={g.projectId} className="cs-trails-project" role="group" aria-label={g.projectName}>
            <div className="cs-crew-heading">{g.projectName}</div>
            {g.trails.map((t) => (
              <TrailRow key={t.worktreeId} trail={t} now={now} focusable={false} />
            ))}
            {histories[g.projectId] === undefined ? (
              <button className="cs-trails-more" aria-label={`Show ${g.projectName}'s history`} onClick={() => ask(g.projectId)}>
                Show history
              </button>
            ) : (
              <div className="cs-trails-history" data-history={g.projectId} tabIndex={-1} role="region" aria-label={`${g.projectName}'s history`}>
                <HistoryList history={histories[g.projectId]} now={now} onRetry={() => ask(g.projectId)} />
              </div>
            )}
          </div>
        ))
      ) : (
        <div className="cs-trails-hint">{SIGNPOST_HINT}</div>
      )}
    </div>
  )
}

/** A trail's row: its flag's colour, its branch, its stage meter, its stage and how long */
function TrailRow({ trail, now, focusable }: { trail: TrailEntry; now: number; focusable: boolean }): React.JSX.Element {
  const status = trailStatus(trail, now)
  return (
    <div className="cs-trail-row" data-trail={focusable ? trail.worktreeId : undefined} tabIndex={focusable ? -1 : undefined} role="group" aria-label={`${trail.branch}: ${status}`}>
      <span className="cs-trail-flag" style={{ background: tentColors(trail.worktreeId)[0] }} aria-hidden="true" />
      <div className="cs-shop-text">
        <span className="cs-trail-branch" title={trail.branch}>
          {trail.branch}
        </span>
        <span className="cs-crew-status">{status}</span>
      </div>
      <span className="cs-trail-meter" role="img" aria-label={meterLabel(trail.stage)}>
        {STAGES.map((name, i) => (
          <span key={name} className={i <= trail.stage ? 'on' : ''} />
        ))}
      </span>
    </div>
  )
}

/** A project's ended trails, newest first; while it loads, or why it couldn't, with Retry */
function HistoryList({ history, now, onRetry }: { history: History | undefined; now: number; onRetry: () => void }): React.JSX.Element | null {
  if (history === undefined) return null
  if (history.state === 'loading') return <div className="cs-crew-empty">Reading the history…</div>
  if (history.state === 'failed') {
    return (
      <div className="cs-crew-empty" role="alert">
        Couldn't load history{' '}
        <button className="cs-trails-more" onClick={onRetry}>
          Retry
        </button>
      </div>
    )
  }
  if (history.log.length === 0) return <div className="cs-crew-empty">No ended trails yet.</div>
  return (
    <ol className="cs-journal cs-trail-log">
      {[...history.log].reverse().map((r, i) => (
        <li key={`${r.end}:${r.branch}:${i}`}>
          <span>{r.branch}</span>
          <span className="cs-journal-when">{historyText(r, now)}</span>
        </li>
      ))}
    </ol>
  )
}
