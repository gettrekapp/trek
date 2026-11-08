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
  const [pickedId, setPickedId] = useState<string | null>(null)
  /** Every entry this view connected to, dropped when it goes (but the one the window opened) */
  const used = useRef<Set<string>>(new Set())

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
      {listError && <div className="error">{listError}</div>}
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
                  disabled={!usable}
                  onClick={() => {
                    used.current.add(server.id)
                    setPickedId(server.id)
                  }}
                >
                  {server.local ? 'Choose a folder…' : 'Choose repositories…'}
                </button>
              </span>
            </div>
          </div>
        )
      })}
      {servers && servers.length === 1 && servers[0].local && (
        <p className="muted hint">To make a project on another machine, add its server in Open on server….</p>
      )}
      {picked && <CreateOn key={picked.id} server={picked} onDone={() => setPickedId(null)} />}
    </div>
  )
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
function CreateOn({ server, onDone }: { server: AppServerLink; onDone: () => void }): React.JSX.Element | null {
  const { registered, status, topic } = useServerTopic(server)
  const [modal, setModal] = useState<{ path?: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const asked = useRef(false)
  const snapshot = topic && 'snapshot' in topic ? topic.snapshot : null
  // From the welcome, never the URL (Note for 4b, 8).
  const isLocal = !!registered.connection.welcome?.capabilities.includes('local')

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

  if (error) return <div className="error">{error}</div>
  if (topic && 'error' in topic) return <div className="error">Could not reach {server.name}: {topic.error}</div>
  if (!snapshot) {
    return (
      <p className="muted connect-projects-status">
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
        // Here, this window becomes the project's (the start screen goes); elsewhere, the picker stays.
        openServerProjectHere(server.id, projectId, name, registered.connection.welcome?.serverName ?? '').then(onDone, (err: unknown) =>
          setError(`Could not open project: ${errorText(err)}`)
        )
      }}
    />
  )
}
