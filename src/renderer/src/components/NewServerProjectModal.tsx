import { useEffect, useState } from 'react'
import { errorCode, errorText } from '../v2/errors'
import type { RegisteredServer } from '../../../shared/client/index.ts'
import type { RemoteRepo } from '../../../shared/protocol'

/** Create a project on a trek-server from repos registered there (`server` topic `repos`). */

interface Props {
  registered: RegisteredServer
  /** The user's label for the server, for the heading */
  serverName: string
  /** Live from the `server` topic */
  repos: RemoteRepo[]
  onClose: () => void
  onCreated: (projectId: string, name: string) => void
}

function baseName(p: string): string {
  return p.replace(/\/+$/, '').split('/').pop() || p
}

export function NewServerProjectModal({ registered, serverName, repos, onClose, onCreated }: Props): React.JSX.Element {
  const [name, setName] = useState('')
  const [ticked, setTicked] = useState<Set<string>>(new Set())
  /** Repos added here whose topic patch may not have arrived yet */
  const [added, setAdded] = useState<RemoteRepo[]>([])
  const [addPath, setAddPath] = useState('')
  const [adding, setAdding] = useState(false)
  const [addError, setAddError] = useState<{ message: string; hint: boolean } | null>(null)
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const allRepos = [...repos, ...added.filter((a) => !repos.some((r) => r.id === a.id))]
  const chosen = allRepos.filter((r) => ticked.has(r.id))
  const canCreate = !!name.trim() && chosen.length > 0 && !creating

  const toggle = (id: string): void =>
    setTicked((t) => {
      const next = new Set(t)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const addRepo = async (): Promise<void> => {
    const path = addPath.trim()
    if (!path) return
    setAdding(true)
    setAddError(null)
    try {
      const { repoId } = await registered.connection.request('server.addRepo', { path })
      if (!repos.some((r) => r.id === repoId)) setAdded((a) => [...a, { id: repoId, name: baseName(path), path }])
      setTicked((t) => new Set(t).add(repoId))
      setAddPath('')
    } catch (err) {
      const code = errorCode(err)
      setAddError({ message: errorText(err), hint: code === 'PATH_DENIED' || code === 'NOT_A_REPO' })
    } finally {
      setAdding(false)
    }
  }

  const create = async (): Promise<void> => {
    if (!canCreate) return
    setCreating(true)
    setCreateError(null)
    try {
      const projectName = name.trim()
      const { projectId } = await registered.connection.request('project.create', {
        name: projectName,
        repositories: chosen.map((r) => ({ path: r.path }))
      })
      onCreated(projectId, projectName)
    } catch (err) {
      setCreateError(`Could not create the project: ${errorText(err)}`)
      setCreating(false)
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal new-server-project" onMouseDown={(e) => e.stopPropagation()}>
        <h2>New project on {serverName || 'server'}</h2>
        <div className="create-row">
          <input
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
          <p className="muted">No repositories are registered on this server yet. Add one by its path below.</p>
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

        <h3>Add repo by path…</h3>
        <div className="create-row">
          <input
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
        {addError && (
          <div className="error">
            <div>{addError.message}</div>
            {addError.hint && (
              <div>
                Run <code>trek-server add &lt;path&gt;</code> on the server.
              </div>
            )}
          </div>
        )}

        {createError && <div className="error">{createError}</div>}
        <div className="modal-footer new-server-project-footer">
          <button onClick={onClose}>Cancel</button>
          <button className="primary" disabled={!canCreate} onClick={() => void create()}>
            {creating ? 'Creating…' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  )
}
