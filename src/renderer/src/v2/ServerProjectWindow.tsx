import { useCallback, useEffect, useRef, useState } from 'react'
import { useAppStore } from '../store'
import { disposeV2Terminals, retryV2Terminals } from '../terminals'
import { backendChanged } from '../backend'
import { connectServerEntry, dropServerEntry } from './serverClients'
import { shouldReconnect, shouldReconnectOnMove } from './appServerLinks'
import { useAppServerLinks } from '../useAppServerLinks'
import { applyV2Project } from './applyProjection'
import { errorText } from './errors'
import { projectGone, watchesServerTopic } from './projectWatch'
import { V2Workspace } from './V2Workspace'
import { STATUS_LABELS, localStatusLabel } from '../../../shared/appServerRules.ts'
import { SERVER_REMOVED_MESSAGE, type ServerConnection, type StatusChange } from '../../../shared/client/index.ts'
import type { AppServerLink } from '../../../shared/types'

/**
 * A v2 server project: the `project:<id>` topic projected into the store and
 * shown by the reused Sidebar, WorktreeDetail and Global panel (V2Workspace),
 * a banner while the connection is down, and the "Server removed" and
 * "Project not found" states. The backend and the store's project setters
 * (setProjectSetters) come and go with `serverWindow` (windowKind.ts).
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

/** The time, plus the date when it isn't today. */
function formatLastSeen(t: number): string {
  const d = new Date(t)
  return d.toDateString() === new Date().toDateString() ? d.toLocaleTimeString() : d.toLocaleString()
}

/** The project's name once a snapshot arrived (the store holds the rest), or why there is none. */
type View = { name: string } | { notFound: true } | { error: string } | null

export function ServerProjectWindow({ serverEntryId, projectId, onTitle }: Props): React.JSX.Element {
  // main's broadcast: a removal or rename in another window shows here at once, even while
  // this window's connection is stuck (needs-auth, incompatible, error) and never retries.
  const { servers, error: listError } = useAppServerLinks()
  /** Set once the entry is gone: for good, it never comes back. */
  const [removed, setRemoved] = useState(false)

  const markRemoved = useCallback(() => {
    setRemoved(true)
    // Stop the connection retrying (it may be stuck in needs-auth or error, or not exist).
    dropServerEntry(serverEntryId)
  }, [serverEntryId])

  const found = servers?.find((s) => s.id === serverEntryId)
  useEffect(() => {
    if (servers && !found) markRemoved()
  }, [servers, found, markRemoved])

  useEffect(() => () => onTitle(null), [onTitle])

  if (removed) return <ServerRemoved onTitle={onTitle} />
  if (listError && !servers) return <ServerWindowMessage title={listError} />
  if (!found) return <div className="server-window" />
  return <ServerProjectTree entry={found} projectId={projectId} onTitle={onTitle} onRemoved={markRemoved} />
}

/** In a Local window's banner: the server's state, and Start when it is not running. */
function LocalServerAction({ local }: { local: NonNullable<AppServerLink['local']> }): React.JSX.Element {
  const [error, setError] = useState<string | null>(null)
  const canStart = local.state === 'stopped' || local.state === 'error'
  return (
    <span className="server-window-local">
      {' · Local server: '}
      {localStatusLabel(local)}
      {canStart && (
        <button
          className="btn btn-ghost"
          onClick={() => {
            setError(null)
            window.api.localServer.start().catch((err: unknown) => setError(errorText(err)))
          }}
        >
          Start Local Server
        </button>
      )}
      {error && <span className="settings-warn"> {error}</span>}
    </span>
  )
}

function ServerProjectTree({
  entry,
  projectId,
  onTitle,
  onRemoved
}: {
  entry: AppServerLink
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
    // The window may already have left this project (leave() runs inside setServerWindow,
    // before React unmounts this): a late status or snapshot must not reach the next store.
    const isCurrent = (): boolean => {
      const target = useAppStore.getState().serverWindow
      return target?.serverEntryId === entry.id && target.projectId === projectId
    }
    // A server without `topicEnd` drops a deleted project's topic silently: the only signal is its
    // `server` topic no longer listing the project. Watched for such a server only, decided at each
    // connect (the welcome is in by then). Only once the project has been listed, so a server
    // snapshot older than a project.create is no "not found".
    let offServer: (() => void) | null = null
    const watchServer = (): void => {
      const want = watchesServerTopic(connection.welcome?.capabilities ?? [])
      if (!want) {
        offServer?.()
        offServer = null
        return
      }
      if (offServer) return
      let seen = false
      offServer = mirror.subscribe('server', (update) => {
        if ('error' in update) return
        if (update.snapshot.projects.some((p) => p.id === projectId)) seen = true
        else if (seen) setView({ notFound: true })
      })
    }
    let previous = connection.status
    const onStatus = (change: StatusChange): void => {
      if (previous === 'connected' && change.status !== 'connected') setDroppedAt(Date.now())
      previous = change.status
      setStatus(change)
      if (change.status === 'connected') watchServer()
      if (!isCurrent()) return
      useAppStore.getState().setServerLink(change.status)
      // The welcome's capabilities may have changed the backend's features.
      backendChanged()
      // Attaches that failed while the link was down go again now, not after their back-off.
      if (change.status === 'connected') retryV2Terminals()
    }
    setStatus(currentStatus(connection))
    if (isCurrent()) useAppStore.getState().setServerLink(connection.status)
    backendChanged()
    const offStatus = connection.on('status', onStatus)
    // gh's sign-in changed on the server (5c-1): the SDK has already moved `prWatch` in the welcome.
    const offPrWatch = connection.on('event', (frame) => {
      if (frame.event !== 'integrations.changed' || !isCurrent()) return
      if (typeof (frame.payload as { prWatch?: unknown } | null)?.prWatch === 'boolean') backendChanged()
    })
    const offTopic = mirror.subscribe(`project:${projectId}`, (update) => {
      if ('error' in update) {
        if (projectGone(update.error)) setView({ notFound: true })
        // Keep showing the last state (a "not found" too) on a transient error; the banner says what is wrong.
        else setView((v) => (v && ('name' in v || 'notFound' in v) ? v : { error: errorText(update.error) }))
        return
      }
      if (!isCurrent()) return
      // Terminals first, then the store: the panes it renders attach to the entries.
      applyV2Project(update.snapshot, registered.ptys)
      setView({ name: update.snapshot.name })
      setLastPatchAt(Date.now())
    })
    if (connection.status === 'connected') watchServer()
    return () => {
      offStatus()
      offPrWatch()
      offTopic()
      offServer?.()
      // The slice and the project setters (setProjectSetters) go with serverWindow (windowKind.ts); the streams go now.
      disposeV2Terminals()
    }
  }, [registered, entry.id, projectId])

  // Stuck states never retry by themselves: once main's connection to the entry is up (a token
  // set, or the server fixed, in any window), this one is worth another try.
  useEffect(() => {
    if (shouldReconnect(entry, registered.connection)) registered.connection.reconnect()
  }, [entry.status, registered])

  // Local respawned on a new port (a restart, a skew restart, a start from here): go there now.
  const lastUrl = useRef(entry.url)
  useEffect(() => {
    if (shouldReconnectOnMove(lastUrl.current, entry, registered.connection)) registered.connection.reconnect()
    lastUrl.current = entry.url
  }, [entry.url, registered])

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
          {entry.local && <LocalServerAction local={entry.local} />}
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

function ProjectNotFound({ entry }: { entry: AppServerLink }): React.JSX.Element {
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
