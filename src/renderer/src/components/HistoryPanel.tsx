import { useEffect, useState } from 'react'
import { getBackend } from '../backend'
import { tagStyle } from '../store'
import { actorLabel, describeParts, groupByDay, mergeHistory } from '../../../shared/historyText'
import type { HistoryEvent } from '../../../shared/model/history'

interface Props {
  visible: boolean
  repoId: string
  branch: string
}

/**
 * What changed on this branch and who changed it, newest first, from the server's history.
 * Loads when shown; while open, new entries arrive live (`history.added`).
 */
export function HistoryPanel({ visible, repoId, branch }: Props): React.JSX.Element {
  const [events, setEvents] = useState<HistoryEvent[]>([])
  const [more, setMore] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!visible) return
    let live = true
    const backend = getBackend()
    setEvents([])
    setMore(false)
    setError(null)
    setLoading(true)
    const off = backend.history.onRecorded((event) => {
      if (event.repoId === repoId && event.branch === branch) setEvents((list) => mergeHistory(list, [event]))
    })
    backend.history
      .list(repoId, branch)
      .then(
        (page) => {
          if (!live) return
          setEvents((list) => mergeHistory(list, page.events))
          setMore(page.more)
        },
        (err: unknown) => {
          if (live) setError(backend.errors.inline(err) ?? 'Could not load the history')
        }
      )
      .finally(() => {
        if (live) setLoading(false)
      })
    return () => {
      live = false
      off()
    }
  }, [visible, repoId, branch])

  const loadOlder = (): void => {
    const oldest = events[events.length - 1]
    if (!oldest) return
    const backend = getBackend()
    setLoading(true)
    backend.history
      .list(repoId, branch, oldest.id)
      .then(
        (page) => {
          setEvents((list) => mergeHistory(list, page.events))
          setMore(page.more)
        },
        (err: unknown) => setError(backend.errors.inline(err) ?? 'Could not load the history')
      )
      .finally(() => setLoading(false))
  }

  return (
    <div className="history-panel" style={{ display: visible ? 'flex' : 'none' }}>
      <div className="history-list">
        {error && <div className="history-error">{error}</div>}
        {!loading && !error && events.length === 0 && <div className="history-empty muted">No changes recorded yet.</div>}
        {groupByDay(events).map((group) => (
          <div key={group.day} className="history-day">
            <h4 className="history-day-label">{group.day}</h4>
            {group.events.map((e) => (
              <div key={e.id} className="history-row">
                <span className="history-time" title={new Date(e.at).toLocaleString()}>
                  {new Date(e.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
                </span>
                <div className="history-body">
                  <div className="history-text">
                    {describeParts(e).map((part, i) =>
                      typeof part === 'string' ? (
                        <span key={i}>{part}</span>
                      ) : (
                        <span key={i} className="chip history-chip" style={part.color ? tagStyle({ id: part.id ?? part.text, name: part.text, color: part.color }) : undefined}>
                          {part.text}
                        </span>
                      )
                    )}
                    <span className={`history-actor history-actor-${e.actor.kind}`}>{actorLabel(e.actor)}</span>
                  </div>
                  {e.reason && <div className="history-reason">{e.reason}</div>}
                </div>
              </div>
            ))}
          </div>
        ))}
        {more && (
          <button className="panel-btn history-more" disabled={loading} onClick={loadOlder}>
            Load older
          </button>
        )}
      </div>
    </div>
  )
}
