// The web client's projects list (5c-3): the server's `server` topic, one
// button per project. Making or importing a project needs a folder on the
// server picked from the app or the CLI; the page opens what is there.
import { useEffect, useState } from 'react'
import { useAppStore } from '../renderer/src/store'
import type { RegisteredServer } from '../shared/client/index.ts'
import type { ProjectSummary } from '../shared/model/types'
import { WEB_ENTRY_ID } from './webApi.ts'

export function ProjectsPage({ registered, status }: { registered: RegisteredServer; status: string }): React.JSX.Element {
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(
    () =>
      registered.mirror.subscribe('server', (update) => {
        if ('error' in update) {
          setError(update.error.message)
          return
        }
        setError(null)
        setProjects([...update.snapshot.projects].sort((a, b) => a.name.localeCompare(b.name)))
      }),
    [registered]
  )

  return (
    <div className="web-projects">
      <h2>Projects</h2>
      {error && <p className="error">Could not list the projects: {error}</p>}
      {projects === null ? (
        <p className="muted">{status === 'connected' ? 'Loading…' : 'Connecting…'}</p>
      ) : projects.length === 0 ? (
        <p className="muted">No projects on this server yet. Make one from the Trek app or with the server's CLI.</p>
      ) : (
        <ul className="web-project-list">
          {projects.map((p) => (
            <li key={p.id}>
              <button
                className="web-project"
                onClick={() => useAppStore.getState().setServerWindow({ serverEntryId: WEB_ENTRY_ID, projectId: p.id })}
              >
                {p.name}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
