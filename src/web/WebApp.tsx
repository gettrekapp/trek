// The web client's page shell (5c-3): a title bar with the server's name, the
// projects list or one project's window (the renderer's ServerProjectWindow,
// unchanged), and Sign out. The page's one connection is the SDK's, over the
// browser's WebSocket (webApi.ts); the URL follows the store's serverWindow.
import { useEffect, useState, useSyncExternalStore } from 'react'
import { useAppStore } from '../renderer/src/store'
import { ServerProjectWindow } from '../renderer/src/v2/ServerProjectWindow'
import { connectServerEntry } from '../renderer/src/v2/serverClients'
import { requestSessionSelect, watchAttention } from '../renderer/src/attentionSelect'
import { useLinearSync } from '../renderer/src/linear'
import { loadLlmSettings } from '../renderer/src/llm'
import { PluginRuntimes, PluginSlot } from '../renderer/src/plugins/PluginHost'
import { titleBarForeground } from '../shared/appearance'
import { STATUS_LABELS } from '../shared/appServerRules.ts'
import type { RegisteredServer } from '../shared/client/index.ts'
import { cancelDialogs } from './dialogQueue.ts'
import { WebDialogHost } from './dialogs.tsx'
import { pathOfProject, projectOfPath } from './routes.ts'
import { WEB_ENTRY_ID, type WebApi } from './webApi.ts'
import { ProjectsPage } from './ProjectsPage.tsx'

/** Set by Sign out: the session's end then closes the socket, and the form's own answer (/login) is where the page goes. */
let signingOut = false

/** Shows the path's project (or the list), as the store's serverWindow. */
function followPath(): void {
  const projectId = projectOfPath(window.location.pathname)
  const store = useAppStore.getState()
  const here = store.serverWindow?.projectId ?? null
  if (projectId === here) return
  store.setServerWindow(projectId ? { serverEntryId: WEB_ENTRY_ID, projectId } : null)
}

function useStatus(registered: RegisteredServer): string {
  return useSyncExternalStore(
    (l) => registered.connection.on('status', l),
    () => registered.connection.status
  )
}

export function WebApp({ web }: { web: WebApi }): React.JSX.Element {
  const [registered] = useState(() => connectServerEntry(WEB_ENTRY_ID))
  const status = useStatus(registered)
  const serverWindow = useAppStore((s) => s.serverWindow)
  const [title, setTitle] = useState<string | null>(null)
  const serverName = registered.connection.welcome?.serverName || 'trek-server'

  useLinearSync()

  useEffect(() => {
    void loadLlmSettings()
    return watchAttention()
  }, [])

  useEffect(() => {
    web.link(registered, () => registered.connection.welcome?.serverName ?? '')
    Object.assign(web.hooks, {
      openProject: (projectId: string) => useAppStore.getState().setServerWindow({ serverEntryId: WEB_ENTRY_ID, projectId }),
      leaveProject: () => useAppStore.getState().setServerWindow(null),
      openAttention: (item) => {
        const store = useAppStore.getState()
        if (store.serverWindow?.projectId !== item.projectId) {
          store.setServerWindow({ serverEntryId: WEB_ENTRY_ID, projectId: item.projectId })
        }
        requestSessionSelect({ projectId: item.projectId, sessionId: item.sessionId, worktreeId: item.worktreeId })
      },
      title: (name) => setTitle(name)
    } satisfies WebApi['hooks'])
    // A token revoked, a sign-out in another tab, a server restart: the cookie no longer signs
    // this page in. The sign-in page is the way back.
    const offStatus = registered.connection.on('status', ({ status: s }) => {
      // The page's path rides along as next; the server keeps it only when it is a project's page.
      if (s === 'needs-auth' && !signingOut) {
        const here = window.location.pathname
        window.location.assign(here === '/' ? '/login' : `/login?next=${encodeURIComponent(here)}`)
      }
      if (s === 'connected') web.relabel()
    })
    return offStatus
  }, [registered, web])

  // The path and the store's serverWindow follow each other: a click on a project (or an
  // attention entry, or "Pick another project") moves the URL; Back and Forward move the window.
  // A dialog still waiting when the shown project changes is about the one left: it is answered
  // with its cancel, so its caller doesn't act on the project now shown.
  useEffect(() => {
    // The server's reload page (a link from another site) came back with its marker: drop it.
    if (new URLSearchParams(window.location.search).has('r')) window.history.replaceState(null, '', window.location.pathname)
    followPath()
    const onPop = (): void => followPath()
    window.addEventListener('popstate', onPop)
    const offStore = useAppStore.subscribe((state, previous) => {
      if (state.serverWindow === previous.serverWindow) return
      if ((state.serverWindow?.projectId ?? null) !== (previous.serverWindow?.projectId ?? null)) cancelDialogs()
      const path = pathOfProject(state.serverWindow?.projectId ?? null)
      if (path !== window.location.pathname) window.history.pushState(null, '', path)
    })
    return () => {
      window.removeEventListener('popstate', onPop)
      offStore()
    }
  }, [])

  useEffect(() => {
    document.title = serverWindow && title ? `${title} · ${serverName}` : `Trek · ${serverName}`
  }, [serverWindow, title, serverName])

  const titleBarColor = useAppStore((s) => (s.serverWindow ? s.project?.titleBarColor : undefined))

  return (
    <div className="app web-app">
      <header
        className={`title-bar web-title-bar ${titleBarColor ? `title-bar-${titleBarForeground(titleBarColor)}` : ''}`}
        style={titleBarColor ? { background: titleBarColor } : undefined}
      >
        <div className="title-side web-title-left">
          {serverWindow && (
            <button className="btn btn-ghost web-projects-link" onClick={() => useAppStore.getState().setServerWindow(null)}>
              ‹ Projects
            </button>
          )}
        </div>
        <span className="title-text">{serverWindow ? (title ?? serverName) : serverName}</span>
        <div className="title-side web-title-right">
          {status !== 'connected' && <span className="web-status">{STATUS_LABELS[status as keyof typeof STATUS_LABELS] ?? status}</span>}
          {/* A plain form: the server ends the session and clears its cookie. */}
          <form
            method="post"
            action="/logout"
            className="web-signout"
            onSubmit={() => {
              signingOut = true
            }}
          >
            <button type="submit" className="btn btn-ghost">
              Sign out
            </button>
          </form>
        </div>
      </header>
      {serverWindow ? (
        <ServerProjectWindow
          key={`${serverWindow.serverEntryId}:${serverWindow.projectId}`}
          serverEntryId={serverWindow.serverEntryId}
          projectId={serverWindow.projectId}
          onTitle={setTitle}
        />
      ) : (
        <ProjectsPage registered={registered} status={status} />
      )}
      <PluginRuntimes />
      <PluginSlot name="overlay" />
      <WebDialogHost />
    </div>
  )
}
