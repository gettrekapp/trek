import { useEffect, useMemo, useState } from 'react'
import { useAppStore } from '../store'
import { connectServerEntry } from './serverClients'
import { errorCode, errorText } from './errors'
import { SERVER_REMOVED_MESSAGE, type ConnectionStatus, type StatusChange } from '../../../shared/client/index.ts'
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

/** As the legacy sidebar's gitStatusLabel. */
function gitLabel(wt: Worktree): string {
  const bits: string[] = []
  if (wt.ahead) bits.push(`↑${wt.ahead}`)
  if (wt.behind) bits.push(`↓${wt.behind}`)
  if (wt.dirty) bits.push('● dirty')
  return bits.join(' ')
}

type View = { project: Project } | { notFound: true } | { error: string } | null

export function ServerProjectWindow({ serverEntryId, projectId, onTitle }: Props): React.JSX.Element {
  /** undefined while loading, null when the entry is gone. */
  const [entry, setEntry] = useState<AppServerInfo | null | undefined>(undefined)
  const [listError, setListError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    window.api.appServers
      .list()
      .then((list) => {
        if (live) setEntry(list.find((s) => s.id === serverEntryId) ?? null)
      })
      .catch((err: unknown) => {
        if (live) setListError(`Could not read the server list: ${errorText(err)}`)
      })
    return () => {
      live = false
    }
  }, [serverEntryId])

  useEffect(() => () => onTitle(null), [onTitle])

  if (listError) return <ServerWindowMessage title={listError} />
  if (entry === undefined) return <div className="server-window" />
  if (entry === null) return <ServerRemoved />
  return <ServerProjectTree entry={entry} projectId={projectId} onTitle={onTitle} />
}

function ServerProjectTree({
  entry,
  projectId,
  onTitle
}: {
  entry: AppServerInfo
  projectId: string
  onTitle: (name: string | null) => void
}): React.JSX.Element {
  const registered = useMemo(() => connectServerEntry(entry.id), [entry.id])
  const [status, setStatus] = useState<StatusChange>({
    status: registered.connection.status,
    message: registered.connection.statusMessage
  })
  const [view, setView] = useState<View>(null)
  const [lastSeen, setLastSeen] = useState<number | null>(null)

  useEffect(() => {
    const { connection, mirror } = registered
    setStatus({ status: connection.status, message: connection.statusMessage })
    const offStatus = connection.on('status', setStatus)
    const offTopic = mirror.subscribe(`project:${projectId}`, (update) => {
      if ('error' in update) {
        if (errorCode(update.error) === 'NOT_FOUND') setView({ notFound: true })
        // Keep showing the last tree on a transient error; the banner says what is wrong.
        else setView((v) => (v && 'project' in v ? v : { error: errorText(update.error) }))
        return
      }
      setView({ project: update.snapshot })
      setLastSeen(Date.now())
    })
    return () => {
      offStatus()
      offTopic()
    }
  }, [registered, projectId])

  const name = view && 'project' in view ? view.project.name : null
  useEffect(() => {
    onTitle(name)
    window.api.reportTitle(name)
  }, [name, onTitle])

  if (status.status === 'error' && status.message === SERVER_REMOVED_MESSAGE) return <ServerRemoved />
  if (view && 'notFound' in view) return <ProjectNotFound entry={entry} />

  const connected = status.status === 'connected'
  return (
    <div className="server-window">
      {!connected && (
        <div className="server-window-banner" role="status">
          <strong>{STATUS_LABELS[status.status]}</strong>
          {status.message ? ` — ${status.message}` : ''}
          {lastSeen !== null && (
            <span className="server-window-last-seen"> · last seen {new Date(lastSeen).toLocaleTimeString()}</span>
          )}
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
  const git = gitLabel(wt)
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

function ServerRemoved(): React.JSX.Element {
  useEffect(() => window.api.reportTitle('Server removed'), [])
  return <ServerWindowMessage title="Server removed" />
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
