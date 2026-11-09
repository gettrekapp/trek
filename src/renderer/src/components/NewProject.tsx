import { useEffect, useRef, useState } from 'react'
import { useAppStore } from '../store'
import { dropServerEntry } from '../v2/serverClients'
import { errorText } from '../v2/errors'
import { useAppServerLinks } from '../useAppServerLinks'
import { NewServerProjectModal } from './NewServerProjectModal'
import { openServerProjectHere, useServerTopic } from './ConnectServer'
import { STATUS_LABELS, localStatusLabel } from '../../../shared/appServerRules.ts'
import type { AppServerLink } from '../../../shared/types'

/**
 * The start screen's New Project view: which server the project goes on (Local first), then
 * Local's folder picker or a remote server's New Project dialog. The project opens in this
 * window once it is made.
 */
export function NewProject({ onBack }: { onBack: () => void }): React.JSX.Element {
  const { servers, error: listError } = useAppServerLinks()
  /** The picked entry; `n` counts the clicks, so a click on the same row starts it afresh */
  const [pick, setPick] = useState<{ id: string; n: number } | null>(null)
  const pickedId = pick?.id ?? null
  /** A created project opening in this window: the rows wait */
  const [opening, setOpening] = useState(false)
  /** Every entry this view connected to, dropped when it goes (but the one the window opened) */
  const used = useRef<Set<string>>(new Set())

  // An entry removed (here or in another window): drop its connection, as Open on server does.
  useEffect(() => {
    if (!servers) return
    const ids = new Set(servers.map((s) => s.id))
    const shown = useAppStore.getState().serverWindow?.serverEntryId
    for (const id of used.current) {
      if (ids.has(id) || id === shown) continue
      dropServerEntry(id)
      used.current.delete(id)
    }
  }, [servers])

  useEffect(
    () => () => {
      const shown = useAppStore.getState().serverWindow?.serverEntryId
      for (const id of used.current) if (id !== shown) dropServerEntry(id)
    },
    []
  )

  const picked = servers?.find((s) => s.id === pickedId) ?? null

  return (
    <div className="connect-server new-project">
      <div className="connect-header">
        <button className="btn btn-ghost" onClick={onBack}>
          ← Back
        </button>
        <h2>New Project</h2>
        <span />
      </div>
      {listError && (
        <div className="error" role="alert">
          {listError}
        </div>
      )}
      {servers && <p className="muted">Where does the project live?</p>}
      {servers?.map((server) => {
        const usable = canCreateOn(server)
        return (
          <div key={server.id} className={`connect-server-item${pickedId === server.id ? ' selected' : ''}`}>
            <div className="server-row">
              <span className="connect-server-name">{server.name}</span>
              <span className="server-row-url">{server.local ? 'this computer' : server.url}</span>
              <span className="connect-server-status">{statusOf(server)}</span>
              <span className="server-row-actions">
                <button
                  className="btn btn-ghost new-project-on"
                  aria-label={`New project on ${server.name}`}
                  aria-pressed={pickedId === server.id}
                  disabled={!usable || opening}
                  onClick={() => {
                    used.current.add(server.id)
                    setPick((p) => ({ id: server.id, n: (p?.n ?? 0) + 1 }))
                  }}
                >
                  {isLocalServer(server) ? 'Choose a folder…' : 'Choose repositories…'}
                </button>
              </span>
            </div>
          </div>
        )
      })}
      {servers && (servers.length === 0 || (servers.length === 1 && servers[0].local)) && (
        <p className="muted hint">To make a project on another machine, add its server in Open on server….</p>
      )}
      {picked && pick && (
        <CreateOn
          key={`${picked.id}:${pick.n}`}
          server={picked}
          onOpening={setOpening}
          // Only this pick's: a later click has started another.
          onDone={() => setPick((p) => (p === pick ? null : p))}
        />
      )}
    </div>
  )
}

/**
 * Local's flow (the folder picker) or a remote server's: the Local entry, or a server whose welcome
 * (as main relays it) says `local`. Never the URL (Note for 4b, 8). The row's label and the flow
 * both use this.
 */
function isLocalServer(server: AppServerLink): boolean {
  return !!server.local || !!server.capabilities?.includes('local')
}

/** A server a project can be made on now: Local running, a remote one with a token. */
function canCreateOn(server: AppServerLink): boolean {
  if (!server.hasToken) return false
  return server.local ? server.local.state === 'running' : true
}

function statusOf(server: AppServerLink): string {
  if (server.local) return localStatusLabel(server.local)
  if (!server.hasToken) return 'Needs a token'
  return server.status ? STATUS_LABELS[server.status] : 'Not connected'
}

/**
 * Makes the project on `server`: once its `server` topic is in, Local asks for the folder first
 * (the modal then registers it and names the project after it); a remote server opens the dialog.
 */
function CreateOn({
  server,
  onOpening,
  onDone
}: {
  server: AppServerLink
  onOpening: (on: boolean) => void
  onDone: () => void
}): React.JSX.Element | null {
  const { registered, status, topic } = useServerTopic(server)
  const [modal, setModal] = useState<{ path?: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const asked = useRef(false)
  const snapshot = topic && 'snapshot' in topic ? topic.snapshot : null
  const isLocal = isLocalServer(server)

  useEffect(() => {
    if (!snapshot || asked.current) return
    asked.current = true
    if (!isLocal) {
      setModal({})
      return
    }
    window.api
      .selectDirectory('Choose a repository for the new project')
      .then((path) => (path ? setModal({ path }) : onDone()))
      .catch((err: unknown) => setError(`Could not choose a folder: ${errorText(err)}`))
  }, [snapshot, isLocal, onDone])

  if (error) {
    return (
      <div className="error" role="alert">
        {error}
      </div>
    )
  }
  if (topic && 'error' in topic) {
    return (
      <div className="error" role="alert">
        Could not reach {server.name}: {topic.error}
      </div>
    )
  }
  if (!snapshot) {
    return (
      <p className="muted connect-projects-status" aria-live="polite">
        {STATUS_LABELS[status.status]}
        {status.message ? ` — ${status.message}` : ''}
      </p>
    )
  }
  if (!modal) return null
  return (
    <NewServerProjectModal
      registered={registered}
      serverName={server.name}
      repos={snapshot.repos}
      local={isLocal}
      initialPath={modal.path}
      onClose={onDone}
      onCreated={(projectId, name) => {
        setModal(null)
        onOpening(true)
        // Here, this window becomes the project's (the start screen goes); elsewhere, the picker stays.
        return openServerProjectHere(server.id, projectId, name, registered.connection.welcome?.serverName ?? '')
          .then(onDone, (err: unknown) =>
            setError(`The project ${name} was created, but could not be opened here: ${errorText(err)}. Open it from Open on server….`)
          )
          .finally(() => onOpening(false))
      }}
    />
  )
}
