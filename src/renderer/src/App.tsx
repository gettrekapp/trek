import { useEffect, useState } from 'react'
import { GLOBAL_WORKTREE_ID, mergedWorktrees, selectedWorktreeInfo, useAppStore } from './store'
import { saveProject } from './persistence'
import { handleWindowCloseRequest, syncWindowProject, watchWindowProject } from './windowLifecycle'
import { focusInGlobalPanel } from './terminals'
import { getBackend } from './backend'
import { StartScreen, type StartView } from './components/StartScreen'
import { ServerProjectWindow } from './v2/ServerProjectWindow'
import { Workspace } from './components/Workspace'
import { GlobalClaude } from './components/GlobalClaude'
import { handleMcpCall } from './mcpTools'
import { requestSessionSelect, watchAttention } from './attentionSelect'
import { useLinearSync } from './linear'
import { loadVoiceSettings } from './voice'
import { loadLlmSettings, watchLlmSettings } from './llm'
import { SummaryBubble } from './components/SummaryBubble'
import { titleBarForeground } from '../../shared/appearance'

export default function App(): React.JSX.Element {
  const project = useAppStore((s) => s.project)
  const filePath = useAppStore((s) => s.filePath)
  const dirty = useAppStore((s) => s.dirty)
  const serverWindow = useAppStore((s) => s.serverWindow)
  /** The server project's name, reported by ServerProjectWindow. */
  const [serverTitle, setServerTitle] = useState<string | null>(null)
  /** False until main says what this window shows, so the start screen never flashes first. */
  const [booted, setBooted] = useState(false)
  /** The start screen's view, asked for by the menu (File → New Project…, Open on Server…) */
  const [startRequest, setStartRequest] = useState<{ view: StartView; n: number } | undefined>(undefined)
  const showStart = (view: StartView): void => setStartRequest((r) => ({ view, n: (r?.n ?? 0) + 1 }))
  // One-shot: once the window has a project, a later start screen (Pick another project) starts fresh.
  useEffect(() => {
    if (project || serverWindow) setStartRequest(undefined)
  }, [project, serverWindow])
  useLinearSync()

  useEffect(() => {
    void loadVoiceSettings()
    void loadLlmSettings()
    return watchLlmSettings()
  }, [])

  useEffect(() => {
    const unsubscribes = [
      window.api.onMenu('save-project', () => void saveProject()),
      // Sent only to an empty window: main opens a new one otherwise.
      window.api.onMenu('new-project', () => showStart('new')),
      window.api.onMenu('open-on-server', () => showStart('connect')),
      window.api.onMenu('new-terminal', () => {
        const state = useAppStore.getState()
        // A server window offline: its commands wait for the connection. A missing worktree runs nothing.
        if (!state.project || !state.selected || state.serverOffline) return
        if (state.serverWindow) {
          const worktrees = mergedWorktrees(state.project, state.hostWorktrees)
          if (selectedWorktreeInfo(state.project, worktrees, state.selected, state.activeWorktreeId)?.prunable) return
        }
        void getBackend().sessions.start(state.selected)
      }),
      window.api.onMenu('close-tab', () => {
        const state = useAppStore.getState()
        if (state.serverOffline) return
        if (focusInGlobalPanel()) {
          // On the Bot tab the active session is hidden, so there is no tab here to close.
          const id = state.globalView === 'sessions' ? state.activeTerminal[GLOBAL_WORKTREE_ID] : undefined
          if (id) void getBackend().sessions.close(id)
        } else if (state.activeWorktreeId) {
          const id = state.activeTerminal[state.activeWorktreeId]
          if (id) void getBackend().sessions.close(id)
        }
      }),
      window.api.onMenu('toggle-global-claude', () => {
        const state = useAppStore.getState()
        if (state.project) state.setGlobalPanelOpen(!state.globalPanelOpen)
      }),
      // An import main opened here: only ever sent to an empty window.
      window.api.onShowServer((server) => {
        const state = useAppStore.getState()
        if (!state.project && !state.serverWindow) state.setServerWindow(server)
      }),
      window.api.onMcpCall((request) => void handleMcpCall(request)),
      window.api.onWindowCloseRequest(() => void handleWindowCloseRequest()),
      watchWindowProject(),
      // Before takeInitialWindowState: main sends selects once the window is listening.
      watchAttention()
    ]
    return () => unsubscribes.forEach((u) => u())
  }, [])

  // After the listeners above: this also tells main the window can answer a close request.
  useEffect(() => {
    window.api
      .takeInitialWindowState()
      .then(async ({ menu, server, select }) => {
        if (server) {
          useAppStore.getState().setServerWindow(server)
          // Asked for while this window was loading: shown once the project is in.
          if (select) requestSessionSelect(select)
          setBooted(true)
          return
        }
        if (menu === 'new-project') showStart('new')
        if (menu === 'open-on-server') showStart('connect')
        setBooted(true)
      })
      .catch(async (err) => {
        setBooted(true)
        syncWindowProject()
        await window.api.showError('Could not open project', String(err))
      })
  }, [])

  const titleBarColor = project?.titleBarColor

  return (
    <div className="app">
      <header
        className={`title-bar ${titleBarColor ? `title-bar-${titleBarForeground(titleBarColor)}` : ''}`}
        style={titleBarColor ? { background: titleBarColor } : undefined}
      >
        <div className="title-side" />
        <span className="title-text">
          {serverWindow ? (
            serverTitle ?? 'Trek Dev'
          ) : project ? (
            <>
              {project.logoImage && <img className="title-logo" src={project.logoImage} alt="" />}
              {project.name}
              {dirty && <span className="dirty-dot" title="Unsaved changes" />}
              <span className="title-path">
                · {filePath ?? 'not saved yet — ⌘S to save'}
              </span>
            </>
          ) : (
            'Trek Dev'
          )}
        </span>
        <div className="title-side" />
      </header>
      {serverWindow ? (
        <ServerProjectWindow
          key={`${serverWindow.serverEntryId}:${serverWindow.projectId}`}
          serverEntryId={serverWindow.serverEntryId}
          projectId={serverWindow.projectId}
          onTitle={setServerTitle}
        />
      ) : project ? (
        <>
          <Workspace />
          <GlobalClaude />
        </>
      ) : booted ? (
        <StartScreen request={startRequest} />
      ) : null}
      <SummaryBubble />
    </div>
  )
}
