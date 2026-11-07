import { useCallback, useEffect, useRef, useState } from 'react'
import { useAppStore } from '../store'
import { disposeV2Terminals, retryV2Terminals } from '../terminals'
import { backendChanged } from '../backend'
import { connectServerEntry, dropServerEntry, registeredServerEntry } from './serverClients'
import { applyV2Project } from './applyProjection'
import { errorCode, errorText } from './errors'
import { V2Workspace } from './V2Workspace'
import { STATUS_LABELS } from '../../../shared/appServerRules.ts'
import { SERVER_REMOVED_MESSAGE, type ServerConnection, type StatusChange } from '../../../shared/client/index.ts'
import type { AppServerInfo } from '../../../shared/types'

/**
 * A v2 server project: the `project:<id>` topic projected into the store and
 * shown by the reused Sidebar, WorktreeDetail and Global panel (V2Workspace),
 * a banner while the connection is down, and the "Server removed" and
 * "Project not found" states. The backend and the store-setter overrides
 * come and go with `serverWindow` (windowKind.ts).
 */

interface Props {
  serverEntryId: string
  projectId: string
  /** The project's name for the title bar, or null while there is none. */
  onTitle: (name: string | null) => void
}

function currentStatus(connection: ServerConnection): StatusChange {
  const { status, statusMessage: message, removed } = connection
  return removed ? { status, message, removed: true } : { status, message }
}

/** A status the SDK does not retry out of (a removed entry's error is final). */
function isStuck(connection: ServerConnection): boolean {
  const { status, removed } = connection
  return status === 'needs-auth' || status === 'incompatible' || (status === 'error' && !removed)
}

/** The time, plus the date when it isn't today. */
function formatLastSeen(t: number): string {
  const d = new Date(t)
  return d.toDateString() === new Date().toDateString() ? d.toLocaleTimeString() : d.toLocaleString()
}

/** The project's name once a snapshot arrived (the store holds the rest), or why there is none. */
type View = { name: string } | { notFound: true } | { error: string } | null

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
          // Stuck states never retry by themselves; the token or URL may have been fixed in another window.
          const connection = registeredServerEntry(serverEntryId)?.connection
          if (connection && isStuck(connection)) connection.reconnect()
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
      useAppStore.getState().setServerOffline(change.status !== 'connected')
      // The welcome's capabilities may have changed the backend's features.
      backendChanged()
      // Attaches that failed while the link was down go again now, not after their back-off.
      if (change.status === 'connected') retryV2Terminals()
    }
    setStatus(currentStatus(connection))
    useAppStore.getState().setServerOffline(connection.status !== 'connected')
    backendChanged()
    const offStatus = connection.on('status', onStatus)
    const offTopic = mirror.subscribe(`project:${projectId}`, (update) => {
      if ('error' in update) {
        if (errorCode(update.error) === 'NOT_FOUND') setView({ notFound: true })
        // Keep showing the last state on a transient error; the banner says what is wrong.
        else setView((v) => (v && 'name' in v ? v : { error: errorText(update.error) }))
        return
      }
      // Terminals first, then the store: the panes it renders attach to the entries.
      applyV2Project(update.snapshot, registered.ptys)
      setView({ name: update.snapshot.name })
      setLastPatchAt(Date.now())
    })
    // A deleted project's topic just stops: the only signal is the server topic dropping it.
    // Only once it has been listed, so a server snapshot older than a project.create is no "not found".
    let seen = false
    const offServer = mirror.subscribe('server', (update) => {
      if ('error' in update) return
      if (update.snapshot.projects.some((p) => p.id === projectId)) seen = true
      else if (seen) setView({ notFound: true })
    })
    return () => {
      offStatus()
      offTopic()
      offServer()
      // The slice and the overrides go with serverWindow (windowKind.ts); the streams go now.
      disposeV2Terminals()
    }
  }, [registered, projectId])

  // Structural (the relay's open result), never the message text.
  const removed = status.removed === true
  useEffect(() => {
    if (removed) onRemoved()
  }, [removed, onRemoved])

  const name = view && 'name' in view ? view.name : null
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
    <div className="server-window server-workspace">
      {!connected && (
        <div className="server-window-banner" role="status">
          <strong>{STATUS_LABELS[status.status]}</strong>
          {status.message ? ` — ${status.message}` : ''}
          {lastSeen !== null && <span className="server-window-last-seen"> · last seen {formatLastSeen(lastSeen)}</span>}
        </div>
      )}
      {view && 'error' in view && <div className="error">Could not load the project: {view.error}</div>}
      {view && 'name' in view ? (
        <V2Workspace />
      ) : (
        !view && connected && <p className="muted server-window-loading">Loading…</p>
      )}
    </div>
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
