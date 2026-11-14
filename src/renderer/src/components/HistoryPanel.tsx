import { useEffect, useRef, useState } from 'react'
import { getBackend } from '../backend'
import { tagStyle, useAppStore } from '../store'
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
  const [reload, setReload] = useState(0)
  const offline = useAppStore((st) => st.serverOffline)
  // Bumped whenever the list is reset (and on cleanup): a page asked for earlier is then ignored.
  const generation = useRef(0)

  useEffect(() => {
    generation.current++
    setEvents([])
    setMore(false)
    setError(null)
    setLoading(false)
    if (!visible || offline) return
    const mine = generation.current
    const backend = getBackend()
    setLoading(true)
    const off = backend.history.onRecorded((event) => {
      if (event.repoId === repoId && event.branch === branch) setEvents((list) => mergeHistory(list, [event]))
    })
    backend.history
      .list(repoId, branch)
      .then(
        (page) => {
          if (generation.current !== mine) return
          setEvents((list) => mergeHistory(list, page.events))
          setMore(page.more)
        },
        (err: unknown) => {
          if (generation.current === mine) setError(backend.errors.inline(err) ?? 'Could not load the history')
        }
      )
      .finally(() => {
        if (generation.current === mine) setLoading(false)
      })
    return () => {
      generation.current++
      off()
    }
  }, [visible, offline, repoId, branch, reload])

  const loadOlder = (): void => {
    const oldest = events[events.length - 1]
    if (!oldest) return
    const mine = generation.current
    const backend = getBackend()
    setError(null)
    setLoading(true)
    backend.history
      .list(repoId, branch, oldest.id)
      .then(
        (page) => {
          if (generation.current !== mine) return
          setEvents((list) => mergeHistory(list, page.events))
          setMore(page.more)
        },
        (err: unknown) => {
          if (generation.current === mine) setError(backend.errors.inline(err) ?? 'Could not load the history')
        }
      )
      .finally(() => {
        if (generation.current === mine) setLoading(false)
      })
  }

  return (
    <div className="history-panel" style={{ display: visible ? 'flex' : 'none' }}>
      <div className="history-list">
        {error && (
          <div className="history-error" role="alert">
            {error}
            {events.length === 0 && (
              <button className="panel-btn history-retry" onClick={() => setReload((n) => n + 1)}>
                Retry
              </button>
            )}
          </div>
        )}
        {!loading && !error && events.length === 0 && <div className="history-empty muted">No changes recorded yet.</div>}
        {groupByDay(events).map((group) => (
          <div key={group.day} className="history-day">
            <h4 className="history-day-label">{group.day}</h4>
            {group.events.map((e) => (
              <div key={e.id} className="history-row">
                <time className="history-time" dateTime={new Date(e.at).toISOString()} title={new Date(e.at).toLocaleString()}>
                  {new Date(e.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
                </time>
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
          <button className="panel-btn history-more" disabled={loading || offline} title={offline ? 'Server disconnected' : undefined} onClick={loadOlder}>
            Load older
          </button>
        )}
      </div>
    </div>
  )
}
