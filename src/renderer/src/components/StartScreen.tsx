import { useEffect, useMemo, useState } from 'react'
import { baseName, useAppStore } from '../store'
import { syncWindowProject } from '../windowLifecycle'
import { errorText } from '../v2/errors'
import { ConnectServer } from './ConnectServer'
import { useAppServerLinks } from '../useAppServerLinks'
import type { OpenedProject, ProjectFile, RecentEntry } from '../../../shared/types'

export function StartScreen(): React.JSX.Element {
  const setProject = useAppStore((s) => s.setProject)
  const setServerWindow = useAppStore((s) => s.setServerWindow)
  // After Pick another project in a server window: straight to Connect, with that server picked.
  const [view, setView] = useState<'home' | 'connect'>(() => (useAppStore.getState().connectServerId ? 'connect' : 'home'))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [recents, setRecents] = useState<RecentEntry[]>([])
  // The app-wide servers' current labels by id, from main's broadcast (so a change in another
  // window shows at once); null until the first snapshot, so nothing shows "Server removed" early.
  const { servers } = useAppServerLinks()
  const serverNames = useMemo(() => (servers ? new Map(servers.map((s) => [s.id, s.name])) : null), [servers])

  // Again on coming back from Connect, which may have opened (and so recorded) a server project.
  useEffect(() => {
    if (view !== 'home') return
    window.api.getRecentProjects().then(setRecents).catch(() => setRecents([]))
  }, [view])

  const removeRecent = async (entry: RecentEntry): Promise<void> => {
    setError(null)
    try {
      setRecents(await window.api.removeRecentProject(entry))
    } catch (err) {
      setError(`Could not remove the recent project: ${errorText(err)}`)
    }
  }

  // Worktrees open unloaded: the sidebar loads each one's saved Claude
  // sessions on demand instead of spawning all of them at once.
  const loadOpened = (opened: OpenedProject): void => {
    setProject(opened.project, opened.filePath)
  }

  const newProject = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const repoPath = await window.api.selectDirectory('Select the target repository')
      if (!repoPath) return
      // Validates that the directory is a git repository before committing.
      await window.api.listWorktrees(null, repoPath)
      const project: ProjectFile = {
        version: 3,
        name: baseName(repoPath),
        repositories: [
          { id: crypto.randomUUID(), name: baseName(repoPath), path: repoPath, worktrees: [] }
        ]
      }
      setProject(project, null)
    } catch (err) {
      setError(`Could not read repository: ${String(err)}`)
    } finally {
      setBusy(false)
    }
  }

  const openProject = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const opened = await window.api.openProject()
      if (!opened) return
      loadOpened(opened)
    } catch (err) {
      syncWindowProject() // main claimed the file for a project that didn't load
      setError(`Could not open project: ${String(err)}`)
    } finally {
      setBusy(false)
    }
  }

  const openRecent = async (filePath: string): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const opened = await window.api.openProjectPath(filePath)
      if (opened) loadOpened(opened)
    } catch (err) {
      syncWindowProject() // main claimed the file for a project that didn't load
      setError(`Could not open project: ${String(err)}`)
      setRecents((r) => r.filter((e) => e.kind !== 'file' || e.path !== filePath))
    } finally {
      setBusy(false)
    }
  }

  // `opened` = this window took the target: it switches to the server view (Task 8 renders it).
  const openServerRecent = async (entry: Extract<RecentEntry, { kind: 'server' }>): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const { opened } = await window.api.openServerProject(entry.serverEntryId, entry.projectId, entry.name, entry.serverName)
      if (opened) setServerWindow({ serverEntryId: entry.serverEntryId, projectId: entry.projectId })
    } catch (err) {
      setError(`Could not open project: ${errorText(err)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="start-screen">
      <h1>Trek Dev</h1>
      <p className="muted">Run coding agents across git worktrees, side by side.</p>
      {error && <div className="error">{error}</div>}
      {view === 'connect' && <ConnectServer onBack={() => setView('home')} />}
      {view === 'home' && (
        <>
          <div className="start-actions">
            <button className="primary" disabled={busy} onClick={() => void newProject()}>
              New Project…
            </button>
            <button disabled={busy} onClick={() => void openProject()}>
              Open Project…
            </button>
            <button disabled={busy} onClick={() => setView('connect')}>
              Connect to server…
            </button>
          </div>
          {recents.length > 0 && (
            <div className="recent-projects">
              <h3>Recent projects</h3>
              <ul>
                {recents.map((entry) =>
                  entry.kind === 'file' ? (
                    <li key={`file:${entry.path}`}>
                      <button disabled={busy} onClick={() => void openRecent(entry.path)}>
                        <span className="recent-name">{baseName(entry.path).replace(/\.trekproj$/, '')}</span>
                        <span className="recent-path">{entry.path}</span>
                      </button>
                      <RemoveRecent disabled={busy} onClick={() => void removeRecent(entry)} />
                    </li>
                  ) : (
                    <li key={`server:${entry.serverEntryId}:${entry.projectId}`}>
                      <button disabled={busy} onClick={() => void openServerRecent(entry)}>
                        <span className="recent-name">
                          {entry.name || entry.projectId}
                          <span className="mini-chip recent-server-chip">{entry.serverEntryId === 'local' ? 'local' : 'server'}</span>
                        </span>
                        <span className="recent-path">
                          {serverNames && !serverNames.has(entry.serverEntryId)
                            ? 'Server removed'
                            : serverNames?.get(entry.serverEntryId) || entry.serverName || 'server'}
                        </span>
                      </button>
                      <RemoveRecent disabled={busy} onClick={() => void removeRecent(entry)} />
                    </li>
                  )
                )}
              </ul>
            </div>
          )}
          <p className="muted hint">
            A project targets one repository; each git worktree gets its own tab of agent terminals.
          </p>
        </>
      )}
    </div>
  )
}

function RemoveRecent({ disabled, onClick }: { disabled: boolean; onClick: () => void }): React.JSX.Element {
  return (
    <button className="recent-remove" title="Remove from recent projects" aria-label="Remove from recent projects" disabled={disabled} onClick={onClick}>
      ×
    </button>
  )
}
