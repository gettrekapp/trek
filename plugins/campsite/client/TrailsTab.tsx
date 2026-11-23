// The camp popover's Trails tab (campsite part 3c): this window's project's trails (each a row: its
// flag's colour, its branch, a five-dot stage meter, its stage and how long it has been there), then
// its history (asked for when the tab opens: the snapshot doesn't carry it); with the trail signpost,
// every other project's trails, each with a "Show history" button; without it, a dimmed line saying
// what the signpost adds. Opened at a trail (a flag clicked), that row takes the focus.
import { useEffect, useRef, useState } from 'react'
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
  const now = useNow()
  // Each project's history, once asked for (this project's when the tab opens)
  const [histories, setHistories] = useState<Record<string, History>>({})
  const alive = useRef(true)
  const load = (id: string): void => {
    setHistories((h) => ({ ...h, [id]: { state: 'loading' } }))
    store.trailLog(id).then(
      (log) => {
        if (alive.current) setHistories((h) => ({ ...h, [id]: { state: 'ready', log } }))
      },
      () => {
        if (alive.current) setHistories((h) => ({ ...h, [id]: { state: 'failed' } }))
      }
    )
  }
  useEffect(() => {
    alive.current = true
    load(projectId)
    return () => {
      alive.current = false
    }
  }, [])
  useEffect(() => {
    if (focus === null) return
    const row = ref.current?.querySelector<HTMLElement>(`[data-trail="${CSS.escape(focus)}"]`)
    if (!row) return
    row.scrollIntoView({ block: 'nearest' })
    row.focus()
  }, [])
  const { here, others } = trailGroups(camp.trails ?? [], projectId)
  return (
    <div ref={ref} className="cs-trails">
      <div className="cs-crew-heading">{here[0]?.projectName ?? 'This project'}</div>
      {here.length === 0 && <div className="cs-crew-empty">{NO_TRAILS}</div>}
      {here.map((t) => (
        <TrailRow key={t.worktreeId} trail={t} now={now} focusable />
      ))}
      <div className="cs-crew-heading">History</div>
      <HistoryList history={histories[projectId]} now={now} onRetry={() => load(projectId)} />
      {(camp.built.signpost ?? 0) >= 1 ? (
        others.map((g) => (
          <div key={g.projectId} className="cs-trails-project" role="group" aria-label={g.projectName}>
            <div className="cs-crew-heading">{g.projectName}</div>
            {g.trails.map((t) => (
              <TrailRow key={t.worktreeId} trail={t} now={now} focusable={false} />
            ))}
            {histories[g.projectId] === undefined ? (
              <button className="cs-trails-more" aria-label={`Show ${g.projectName}'s history`} onClick={() => load(g.projectId)}>
                Show history
              </button>
            ) : (
              <HistoryList history={histories[g.projectId]} now={now} onRetry={() => load(g.projectId)} />
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
