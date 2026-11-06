import { useCallback, useEffect, useRef, useState } from 'react'
import { useAppStore } from '../store'
import { connectServerEntry, dropServerEntry } from './serverClients'
import { errorCode, errorText } from './errors'
import { gitStatusLabel } from '../components/Sidebar'
import { SERVER_REMOVED_MESSAGE, type ConnectionStatus, type ServerConnection, type StatusChange } from '../../../shared/client/index.ts'
import type { Project, Session, SessionStatus, Worktree } from '../../../shared/model/types'
import type { AppServerInfo } from '../../../shared/types'

/**
 * A v2 server project, read-only (3b): the live tree from the `project:<id>`
 * topic, a banner while the connection is down, and the "Server removed" and
 * "Project not found" states. 3c replaces it with the real Sidebar/Workspace.
 */

interface Props {
  serverEntryId: string
  projectId: string
  /** The project's name for the title bar, or null while there is none. */
  onTitle: (name: string | null) => void
}

const STATUS_LABELS: Record<ConnectionStatus, string> = {
  connected: 'Connected',
  connecting: 'Connecting…',
  disconnected: 'Disconnected',
  'needs-auth': 'Token rejected',
  incompatible: 'Incompatible',
  error: 'Error',
  closed: 'Closed'
}

/** The legacy sidebar's dot colours. */
function sessionDot(status: SessionStatus): string {
  switch (status) {
    case 'working':
      return 'running'
    case 'attention':
      return 'attention'
    case 'done':
      return 'done'
    case 'exited':
      return 'exited'
    default:
      return 'idle'
  }
}

function currentStatus(connection: ServerConnection): StatusChange {
  const { status, statusMessage: message, removed } = connection
  return removed ? { status, message, removed: true } : { status, message }
}

/** The time, plus the date when it isn't today. */
function formatLastSeen(t: number): string {
  const d = new Date(t)
  return d.toDateString() === new Date().toDateString() ? d.toLocaleTimeString() : d.toLocaleString()
}

type View = { project: Project } | { notFound: true } | { error: string } | null

export function ServerProjectWindow({ serverEntryId, projectId, onTitle }: Props): React.JSX.Element {
  /** undefined while loading, null when the entry is gone (for good: it never comes back). */
  const [entry, setEntry] = useState<AppServerInfo | null | undefined>(undefined)
  const [listError, setListError] = useState<string | null>(null)
  const loaded = useRef(false)

  const markRemoved = useCallback(() => {
    loaded.current = true
    setEntry(null)
    // Stop the connection retrying (it may be stuck in needs-auth or error, or not exist).
    dropServerEntry(serverEntryId)
  }, [serverEntryId])

  // At mount and on every focus: a removal or rename in another window shows here
  // even while the connection is stuck (needs-auth, incompatible, error) and never retries.
  useEffect(() => {
    let live = true
    const check = (): void => {
      window.api.appServers
        .list()
        .then((list) => {
          if (!live) return
          const found = list.find((s) => s.id === serverEntryId)
          if (!found) return markRemoved()
          loaded.current = true
          setListError(null)
          setEntry((prev) => (prev === null ? null : found))
        })
        .catch((err: unknown) => {
          // A failed re-check keeps what is shown; only a failed first read says so.
          if (live && !loaded.current) setListError(`Could not read the server list: ${errorText(err)}`)
        })
    }
    check()
    window.addEventListener('focus', check)
    return () => {
      live = false
      window.removeEventListener('focus', check)
    }
  }, [serverEntryId, markRemoved])

  useEffect(() => () => onTitle(null), [onTitle])

  if (listError) return <ServerWindowMessage title={listError} />
  if (entry === undefined) return <div className="server-window" />
  if (entry === null) return <ServerRemoved onTitle={onTitle} />
  return <ServerProjectTree entry={entry} projectId={projectId} onTitle={onTitle} onRemoved={markRemoved} />
}

function ServerProjectTree({
  entry,
  projectId,
  onTitle,
  onRemoved
}: {
  entry: AppServerInfo
  projectId: string
  onTitle: (name: string | null) => void
  /** The relay reported the entry gone: the parent shows "Server removed". */
  onRemoved: () => void
}): React.JSX.Element {
  // The window is keyed by entry and project, so the entry id never changes here.
  const [registered] = useState(() => connectServerEntry(entry.id))
  const [status, setStatus] = useState<StatusChange>(() => currentStatus(registered.connection))
  const [view, setView] = useState<View>(null)
  /** The last patch, and the time the connection last dropped: "last seen" is the later. */
  const [lastPatchAt, setLastPatchAt] = useState<number | null>(null)
  const [droppedAt, setDroppedAt] = useState<number | null>(null)

  useEffect(() => {
    const { connection, mirror } = registered
    let previous = connection.status
    const onStatus = (change: StatusChange): void => {
      if (previous === 'connected' && change.status !== 'connected') setDroppedAt(Date.now())
      previous = change.status
      setStatus(change)
    }
    setStatus(currentStatus(connection))
    const offStatus = connection.on('status', onStatus)
    const offTopic = mirror.subscribe(`project:${projectId}`, (update) => {
      if ('error' in update) {
        if (errorCode(update.error) === 'NOT_FOUND') setView({ notFound: true })
        // Keep showing the last tree on a transient error; the banner says what is wrong.
        else setView((v) => (v && 'project' in v ? v : { error: errorText(update.error) }))
        return
      }
      setView({ project: update.snapshot })
      setLastPatchAt(Date.now())
    })
    return () => {
      offStatus()
      offTopic()
    }
  }, [registered, projectId])

  // Structural (the relay's open result), never the message text.
  const removed = status.removed === true
  useEffect(() => {
    if (removed) onRemoved()
  }, [removed, onRemoved])

  const name = view && 'project' in view ? view.project.name : null
  useEffect(() => {
    if (removed) return
    onTitle(name)
    window.api.reportTitle(name)
  }, [name, onTitle, removed])

  if (removed) return <div className="server-window" />
  if (view && 'notFound' in view) return <ProjectNotFound entry={entry} />

  const connected = status.status === 'connected'
  const lastSeen = lastPatchAt === null && droppedAt === null ? null : Math.max(lastPatchAt ?? 0, droppedAt ?? 0)
  return (
    <div className="server-window">
      {!connected && (
        <div className="server-window-banner" role="status">
          <strong>{STATUS_LABELS[status.status]}</strong>
          {status.message ? ` — ${status.message}` : ''}
          {lastSeen !== null && <span className="server-window-last-seen"> · last seen {formatLastSeen(lastSeen)}</span>}
        </div>
      )}
      {view && 'error' in view && <div className="error">Could not load the project: {view.error}</div>}
      {view && 'project' in view ? (
        <ProjectTree project={view.project} />
      ) : (
        !view && connected && <p className="muted server-window-loading">Loading…</p>
      )}
    </div>
  )
}

function ProjectTree({ project }: { project: Project }): React.JSX.Element {
  return (
    <div className="server-window-tree sidebar-list">
      {project.repositories.map((repo) => (
        <section className="repo-section" key={repo.id}>
          <div className="repo-header" title={repo.path}>
            <span className="repo-name">{repo.name}</span>
          </div>
          {repo.worktrees.map((wt) => (
            <WorktreeRow key={wt.id} worktree={wt} />
          ))}
        </section>
      ))}
      <section className="repo-section server-window-global">
        <div className="repo-header">
          <span className="repo-name">Global</span>
        </div>
        {project.globalSessions.length === 0 ? (
          <p className="muted server-window-empty">No global sessions</p>
        ) : (
          <SessionList sessions={project.globalSessions} />
        )}
      </section>
    </div>
  )
}

function WorktreeRow({ worktree: wt }: { worktree: Worktree }): React.JSX.Element {
  const git = gitStatusLabel(wt)
  return (
    <div className="server-window-worktree">
      <div className="wt-row" title={wt.path}>
        <span className={`wt-dot ${wt.loaded ? 'done' : 'dormant'}`} title={wt.loaded ? 'Loaded' : 'Unloaded'} />
        <div className="wt-main">
          <div className="wt-branch">
            <span className="wt-branch-label">
              <span className="wt-name">{wt.branch ?? wt.name}</span>
            </span>
            {wt.isMain && <span className="primary-tag remote-main-tag">MAIN</span>}
          </div>
          {(wt.missing || wt.loaded || git) && (
            <div className="wt-bottom">
              <div className="wt-chips">
                {wt.missing && <span className="mini-chip server-window-missing">missing</span>}
                {wt.loaded && <span className="mini-chip">loaded</span>}
              </div>
              {git && <span className={`wt-git ${wt.dirty ? 'dirty' : ''}`}>{git}</span>}
            </div>
          )}
        </div>
      </div>
      {wt.sessions.length > 0 && <SessionList sessions={wt.sessions} />}
    </div>
  )
}

function SessionList({ sessions }: { sessions: Session[] }): React.JSX.Element {
  return (
    <ul className="server-window-sessions">
      {sessions.map((s) => (
        <li key={s.id} title={s.status}>
          <span className={`wt-dot ${sessionDot(s.status)}`} />
          <span className="server-window-session-title">{s.title || 'Session'}</span>
        </li>
      ))}
    </ul>
  )
}

function ServerWindowMessage({ title, children }: { title: string; children?: React.ReactNode }): React.JSX.Element {
  return (
    <div className="server-window server-window-message">
      <h2>{title}</h2>
      <div className="server-window-actions">
        <button onClick={() => window.close()}>Close</button>
        {children}
      </div>
    </div>
  )
}

/** Both titles (the window's and the in-app title bar) say so. */
function ServerRemoved({ onTitle }: { onTitle: (name: string | null) => void }): React.JSX.Element {
  useEffect(() => {
    onTitle(SERVER_REMOVED_MESSAGE)
    window.api.reportTitle(SERVER_REMOVED_MESSAGE)
  }, [onTitle])
  return <ServerWindowMessage title={SERVER_REMOVED_MESSAGE} />
}

function ProjectNotFound({ entry }: { entry: AppServerInfo }): React.JSX.Element {
  const [error, setError] = useState<string | null>(null)
  const pickAnother = async (): Promise<void> => {
    try {
      await window.api.releaseTarget()
    } catch (err) {
      setError(errorText(err))
      return
    }
    const store = useAppStore.getState()
    store.setConnectServerId(entry.id)
    store.setServerWindow(null)
  }
  return (
    <ServerWindowMessage title={`Project not found on ${entry.name}`}>
      <button className="primary" onClick={() => void pickAnother()}>
        Pick another project
      </button>
      {error && <div className="error">{error}</div>}
    </ServerWindowMessage>
  )
}
