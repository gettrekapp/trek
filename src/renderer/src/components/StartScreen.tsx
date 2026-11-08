import { useEffect, useMemo, useState } from 'react'
import { baseName, useAppStore } from '../store'
import { syncWindowProject } from '../windowLifecycle'
import { errorText } from '../v2/errors'
import { ConnectServer, openServerProjectHere } from './ConnectServer'
import { NewProject } from './NewProject'
import { useAppServerLinks } from '../useAppServerLinks'
import { LOCAL_ENTRY_ID } from '../../../shared/appServerRules.ts'
import type { RecentEntry } from '../../../shared/types'

export type StartView = 'home' | 'connect' | 'new'

/**
 * An empty window: Open on server… (the servers, Local first, and their projects), New Project…
 * (on a server: Local's folder picker, or a remote server's dialog), Import .trekproj…, and the
 * recent projects. A recent .trekproj is one not imported yet: opening it imports it.
 * `request` switches the view (File → New Project…, Open on Server…); its `n` makes a repeat count.
 */
export function StartScreen({ request }: { request?: { view: StartView; n: number } }): React.JSX.Element {
  const setProject = useAppStore((s) => s.setProject)
  // After Pick another project in a server window: straight to Open on server, with that server picked.
  const [view, setView] = useState<StartView>(() => (useAppStore.getState().connectServerId ? 'connect' : (request?.view ?? 'home')))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [recents, setRecents] = useState<RecentEntry[]>([])
  // The app-wide servers' current labels by id, from main's broadcast (so a change in another
  // window shows at once); null until the first snapshot, so nothing shows "Server removed" early.
  const { servers } = useAppServerLinks()
  const serverNames = useMemo(() => (servers ? new Map(servers.map((s) => [s.id, s.name])) : null), [servers])

  useEffect(() => {
    if (request) setView(request.view)
  }, [request])

  // Again on coming back from another view, which may have opened (and so recorded) a server project.
  useEffect(() => {
    if (view !== 'home') return
    window.api.getRecentProjects().then(setRecents).catch(() => setRecents([]))
  }, [view])

  const refreshRecents = (): void => {
    window.api.getRecentProjects().then(setRecents).catch(() => undefined)
  }

  const removeRecent = async (entry: RecentEntry): Promise<void> => {
    setError(null)
    try {
      setRecents(await window.api.removeRecentProject(entry))
    } catch (err) {
      setError(`Could not remove the recent project: ${errorText(err)}`)
    }
  }

  // Main imports the file (asking about servers, showing the result) and opens its projects here.
  const importFile = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await window.api.importTrekproj()
      refreshRecents()
    } catch (err) {
      setError(`Could not import: ${errorText(err)}`)
    } finally {
      setBusy(false)
    }
  }

  // A .trekproj not imported yet: imported now. One imported already opens what it became.
  const openRecent = async (filePath: string): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const opened = await window.api.openProjectPath(filePath)
      if (opened) setProject(opened.project, opened.filePath)
      // Imported: the file's entry became its server projects'.
      else refreshRecents()
    } catch (err) {
      syncWindowProject() // main claimed the file for a project that didn't load
      setError(`Could not open project: ${String(err)}`)
      setRecents((r) => r.filter((e) => e.kind !== 'file' || e.path !== filePath))
    } finally {
      setBusy(false)
    }
  }

  const openServerRecent = async (entry: Extract<RecentEntry, { kind: 'server' }>): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await openServerProjectHere(entry.serverEntryId, entry.projectId, entry.name, entry.serverName)
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
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      {view === 'connect' && <ConnectServer onBack={() => setView('home')} />}
      {view === 'new' && <NewProject onBack={() => setView('home')} />}
      {view === 'home' && (
        <>
          <div className="start-actions">
            <button className="primary" disabled={busy} onClick={() => setView('new')}>
              New Project…
            </button>
            <button disabled={busy} onClick={() => setView('connect')}>
              Open on server…
            </button>
            <button disabled={busy} onClick={() => void importFile()}>
              Import .trekproj…
            </button>
          </div>
          {recents.length > 0 && (
            <div className="recent-projects">
              <h3>Recent projects</h3>
              <ul>
                {recents.map((entry) =>
                  entry.kind === 'file' ? (
                    <li key={`file:${entry.path}`}>
                      <button disabled={busy} title="Import this project file" onClick={() => void openRecent(entry.path)}>
                        <span className="recent-name">
                          {baseName(entry.path).replace(/\.trekproj$/, '')}
                          <span className="mini-chip recent-server-chip">import</span>
                        </span>
                        <span className="recent-path">{entry.path}</span>
                      </button>
                      <RemoveRecent disabled={busy} onClick={() => void removeRecent(entry)} />
                    </li>
                  ) : (
                    <li key={`server:${entry.serverEntryId}:${entry.projectId}`}>
                      <button disabled={busy} onClick={() => void openServerRecent(entry)}>
                        <span className="recent-name">
                          {entry.name || entry.projectId}
                          <span className="mini-chip recent-server-chip">{entry.serverEntryId === LOCAL_ENTRY_ID ? 'local' : 'server'}</span>
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
            Every project lives on a server: the Local server on this computer, or one of yours. Each git worktree gets its own tab of agent terminals.
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
