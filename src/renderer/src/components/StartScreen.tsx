import { useEffect, useState } from 'react'
import { baseName, useAppStore } from '../store'
import { syncWindowProject } from '../windowLifecycle'
import type { OpenedProject, ProjectFile, RecentEntry } from '../../../shared/types'

export function StartScreen(): React.JSX.Element {
  const setProject = useAppStore((s) => s.setProject)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [recents, setRecents] = useState<RecentEntry[]>([])
  /** Ids of the app-wide servers; null until loaded, so nothing shows "Server removed" early. */
  const [serverIds, setServerIds] = useState<Set<string> | null>(null)

  useEffect(() => {
    window.api.getRecentProjects().then(setRecents).catch(() => setRecents([]))
    // Servers can be added or removed from another window, so re-read on focus too.
    const loadServers = (): void => {
      window.api.appServers
        .list()
        .then((list) => setServerIds(new Set(list.map((s) => s.id))))
        .catch(() => setServerIds(null))
    }
    loadServers()
    window.addEventListener('focus', loadServers)
    return () => window.removeEventListener('focus', loadServers)
  }, [])

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

  // Task 8 boots the window into the server view when `opened` is true.
  const openServerRecent = async (entry: Extract<RecentEntry, { kind: 'server' }>): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await window.api.openServerProject(entry.serverEntryId, entry.projectId, entry.name, entry.serverName)
    } catch (err) {
      setError(`Could not open project: ${String(err)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="start-screen">
      <h1>Trek Dev</h1>
      <p className="muted">Run coding agents across git worktrees, side by side.</p>
      {error && <div className="error">{error}</div>}
      <div className="start-actions">
        <button className="primary" disabled={busy} onClick={() => void newProject()}>
          New Project…
        </button>
        <button disabled={busy} onClick={() => void openProject()}>
          Open Project…
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
                </li>
              ) : (
                <li key={`server:${entry.serverEntryId}:${entry.projectId}`}>
                  <button disabled={busy} onClick={() => void openServerRecent(entry)}>
                    <span className="recent-name">
                      {entry.name || entry.projectId} — {entry.serverName || 'server'}
                    </span>
                    {serverIds && !serverIds.has(entry.serverEntryId) && (
                      <span className="recent-path">Server removed</span>
                    )}
                  </button>
                </li>
              )
            )}
          </ul>
        </div>
      )}
      <p className="muted hint">
        A project targets one repository; each git worktree gets its own tab of agent terminals.
      </p>
    </div>
  )
}
