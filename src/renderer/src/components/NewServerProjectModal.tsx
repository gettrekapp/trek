import { useEffect, useId, useRef, useState } from 'react'
import { errorCode, errorText } from '../v2/errors'
import { whileCreating } from '../createGuard'
import type { RegisteredServer } from '../../../shared/client/index.ts'
import type { RemoteRepo } from '../../../shared/protocolV2'

/**
 * Create a project on a trek-server from repos registered there (`server` topic `repos`).
 * On the Local server (its welcome lists `local`) repos are added with the native folder
 * picker instead of a typed path: the user is choosing on their own disk, and the local
 * server takes any path.
 */

interface Props {
  registered: RegisteredServer
  /** The user's label for the server, for the heading */
  serverName: string
  /** Live from the `server` topic */
  repos: RemoteRepo[]
  onClose: () => void
  /** Opens the new project; its promise settles once the open has (the create guard holds until then) */
  onCreated: (projectId: string, name: string) => Promise<void>
  /** The Local server: "Add a folder…" opens the folder picker */
  local?: boolean
  /** A folder already picked (New Project on Local picks first): added at once, and names the project */
  initialPath?: string
}

/** How long Create waits for an added repo's `server` topic patch before it says so. */
const TOPIC_WAIT_MS = 5000

function baseName(p: string): string {
  return p.replace(/\/+$/, '').split('/').pop() || p
}

export function NewServerProjectModal({ registered, serverName, repos, onClose, onCreated, local = false, initialPath }: Props): React.JSX.Element {
  const [name, setName] = useState(() => (initialPath ? baseName(initialPath) : ''))
  const [ticked, setTicked] = useState<Set<string>>(new Set())
  /** Repos added here whose topic patch may not have arrived yet */
  const [added, setAdded] = useState<RemoteRepo[]>([])
  const [addPath, setAddPath] = useState('')
  const [adding, setAdding] = useState(false)
  const [addError, setAddError] = useState<{ message: string; hint: boolean } | null>(null)
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  // Enter can fire again before the re-render that disables the buttons: guard on refs.
  const addingRef = useRef(false)
  const creatingRef = useRef(false)
  const nameId = useId()
  const pathId = useId()

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const allRepos = [...repos, ...added.filter((a) => !repos.some((r) => r.id === a.id))]
  const chosen = allRepos.filter((r) => ticked.has(r.id))
  /**
   * Ticked repos added here whose `server` topic patch has not arrived yet. Create
   * waits for it, so project.create gets the server's canonical repo path (the
   * resolved repo root), never the path as typed.
   */
  const awaitingTopic = chosen.some((r) => !repos.some((t) => t.id === r.id))
  const canCreate = !!name.trim() && chosen.length > 0 && !awaitingTopic && !creating
  /** The patch is overdue: say so, and offer Retry (a fresh connection resubscribes and gets a new snapshot). */
  const [topicStalled, setTopicStalled] = useState(false)
  const [retries, setRetries] = useState(0)
  useEffect(() => {
    setTopicStalled(false)
    if (!awaitingTopic) return
    const timer = setTimeout(() => setTopicStalled(true), TOPIC_WAIT_MS)
    return () => clearTimeout(timer)
  }, [awaitingTopic, retries])
  const retryTopic = (): void => {
    registered.connection.reconnect()
    setRetries((n) => n + 1)
  }

  const toggle = (id: string): void =>
    setTicked((t) => {
      const next = new Set(t)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const addRepo = async (path = addPath.trim()): Promise<void> => {
    if (!path || addingRef.current) return
    addingRef.current = true
    setAdding(true)
    setAddError(null)
    try {
      const { repoId } = await registered.connection.request('server.addRepo', { path })
      if (!repos.some((r) => r.id === repoId)) setAdded((a) => [...a, { id: repoId, name: baseName(path), path }])
      setTicked((t) => new Set(t).add(repoId))
      if (path === addPath.trim()) setAddPath('')
    } catch (err) {
      const code = errorCode(err)
      setAddError({ message: errorText(err), hint: code === 'PATH_DENIED' || code === 'NOT_A_REPO' })
    } finally {
      addingRef.current = false
      setAdding(false)
    }
  }

  // The folder New Project on Local picked: registered (or found registered) once.
  const initialAdded = useRef(false)
  useEffect(() => {
    if (!initialPath || initialAdded.current) return
    initialAdded.current = true
    void addRepo(initialPath)
  })

  const pickFolder = async (): Promise<void> => {
    const path = await window.api.selectDirectory('Choose a repository')
    if (path) await addRepo(path)
  }

  const create = async (): Promise<void> => {
    if (!canCreate || creatingRef.current) return
    creatingRef.current = true
    setCreating(true)
    setCreateError(null)
    // The start screen keeps its view until the project is created and its open has settled.
    await whileCreating(async () => {
      const projectName = name.trim()
      let projectId: string
      try {
        ;({ projectId } = await registered.connection.request('project.create', {
          name: projectName,
          // From the topic: canCreate waits until every ticked repo is in it.
          repositories: chosen.map((r) => ({ path: repos.find((t) => t.id === r.id)?.path ?? r.path }))
        }))
      } catch (err) {
        setCreateError(`Could not create the project: ${errorText(err)}`)
        creatingRef.current = false
        setCreating(false)
        return
      }
      // The caller shows a failed open itself.
      // Promise.resolve().then: a synchronous throw is caught too.
      await Promise.resolve()
        .then(() => onCreated(projectId, projectName))
        .catch(() => {})
    })
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal new-server-project" onMouseDown={(e) => e.stopPropagation()}>
        <h2>New project on {serverName || 'server'}</h2>
        <div className="create-row">
          <label className="visually-hidden" htmlFor={nameId}>
            Project name
          </label>
          <input
            id={nameId}
            type="text"
            autoFocus
            placeholder="Project name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void create()
            }}
          />
        </div>

        <h3>Repositories</h3>
        {allRepos.length === 0 ? (
          <p className="muted">
            {local ? 'No repositories on this computer yet. Add a folder below.' : 'No repositories are registered on this server yet. Add one by its path below.'}
          </p>
        ) : (
          <ul className="worktree-list">
            {allRepos.map((repo) => (
              <li key={repo.id}>
                <label className="new-server-project-repo">
                  <input type="checkbox" checked={ticked.has(repo.id)} onChange={() => toggle(repo.id)} />
                  <span className="worktree-info">
                    <span className="worktree-branch">{repo.name}</span>
                    <span className="worktree-path">{repo.path}</span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        )}

        {local ? (
          <div className="create-row">
            <button disabled={adding} onClick={() => void pickFolder()}>
              {adding ? 'Adding…' : 'Add a folder…'}
            </button>
          </div>
        ) : (
          <>
            <h3>
              <label htmlFor={pathId}>Add repo by path…</label>
            </h3>
            <div className="create-row">
              <input
                id={pathId}
                type="text"
                placeholder="/home/dev/repos/my-app (a path on the server)"
                spellCheck={false}
                value={addPath}
                onChange={(e) => setAddPath(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void addRepo()
                }}
              />
              <button disabled={adding || !addPath.trim()} onClick={() => void addRepo()}>
                {adding ? 'Adding…' : 'Add'}
              </button>
            </div>
          </>
        )}
        {addError && (
          <div className="error">
            <div>{addError.message}</div>
            {addError.hint && !local && (
              <div>
                Run <code>trek-server add &lt;path&gt;</code> on the server.
              </div>
            )}
          </div>
        )}

        {createError && <div className="error">{createError}</div>}
        {awaitingTopic && topicStalled && (
          <div className="error">
            The server has not confirmed the added repo yet, so Create cannot use its path on the server. The
            connection may be down: Retry reconnects, or untick the repo.
          </div>
        )}
        <div className="modal-footer new-server-project-footer">
          <button onClick={onClose}>Cancel</button>
          {awaitingTopic && topicStalled ? (
            <button className="primary" onClick={retryTopic}>
              Retry
            </button>
          ) : (
            <button className="primary" disabled={!canCreate} onClick={() => void create()}>
              {creating ? 'Creating…' : awaitingTopic ? 'Waiting for the server…' : 'Create'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
