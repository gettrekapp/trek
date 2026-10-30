import { useEffect, useState } from 'react'
import { baseName, useAppStore } from '../store'
import type { OpenedProject, ProjectFile } from '../../../shared/types'

export function StartScreen(): React.JSX.Element {
  const setProject = useAppStore((s) => s.setProject)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [recents, setRecents] = useState<string[]>([])

  useEffect(() => {
    window.api.getRecentProjects().then(setRecents).catch(() => setRecents([]))
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
        version: 2,
        name: baseName(repoPath),
        repositoryPath: repoPath,
        worktrees: []
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
      loadOpened(opened)
    } catch (err) {
      setError(`Could not open project: ${String(err)}`)
      setRecents((r) => r.filter((p) => p !== filePath))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="start-screen">
      <h1>Trek Dev</h1>
      <p className="muted">Run Claude across git worktrees, side by side.</p>
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
            {recents.map((filePath) => (
              <li key={filePath}>
                <button disabled={busy} onClick={() => void openRecent(filePath)}>
                  <span className="recent-name">{baseName(filePath).replace(/\.trekproj$/, '')}</span>
                  <span className="recent-path">{filePath}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      <p className="muted hint">
        A project targets one repository; each git worktree gets its own tab of Claude terminals.
      </p>
    </div>
  )
}
