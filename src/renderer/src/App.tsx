import { useCallback, useEffect } from 'react'
import { GLOBAL_WORKTREE_ID, migrateProject, useAppStore } from './store'
import { saveProject } from './persistence'
import { handleWindowCloseRequest, syncWindowProject, watchWindowProject } from './windowLifecycle'
import {
  closeGlobalTerminal,
  disposeAllTerminals,
  disposeTerminal,
  focusInGlobalPanel,
  startClaudeSession
} from './terminals'
import { StartScreen } from './components/StartScreen'
import { Workspace } from './components/Workspace'
import { GlobalClaude } from './components/GlobalClaude'
import { handleMcpCall } from './mcpTools'
import { watchBot } from './bot'
import { useLinearSync } from './linear'
import { loadVoiceSettings } from './voice'
import { loadLlmSettings, watchLlmSettings } from './llm'
import { SummaryBubble } from './components/SummaryBubble'
import { titleBarForeground } from '../../shared/appearance'

export default function App(): React.JSX.Element {
  const project = useAppStore((s) => s.project)
  const filePath = useAppStore((s) => s.filePath)
  const dirty = useAppStore((s) => s.dirty)
  useLinearSync()

  useEffect(() => {
    void loadVoiceSettings()
    void loadLlmSettings()
    return watchLlmSettings()
  }, [])

  const openProject = useCallback(async (): Promise<void> => {
    try {
      const opened = await window.api.openProject()
      if (!opened) return
      // Migrate first: an invalid file must not cost the open project its sessions.
      const project = migrateProject(opened.project)
      disposeAllTerminals()
      // Worktrees open unloaded — the sidebar loads each one's saved sessions on
      // demand, so a project with dozens of them doesn't launch dozens of claudes.
      useAppStore.getState().setProject(project, opened.filePath)
    } catch (err) {
      syncWindowProject() // main claimed the file for a project that didn't load
      await window.api.showError('Could not open project', String(err))
    }
  }, [])

  useEffect(() => {
    const unsubscribes = [
      window.api.onMenu('save-project', () => void saveProject()),
      window.api.onMenu('open-project', () => void openProject()),
      window.api.onMenu('new-terminal', () => {
        const state = useAppStore.getState()
        if (state.project && state.selected) void startClaudeSession(state.selected)
      }),
      window.api.onMenu('close-tab', () => {
        const state = useAppStore.getState()
        if (focusInGlobalPanel()) {
          // On the Bot tab the active session is hidden, so there is no tab here to close.
          const id = state.globalView === 'sessions' ? state.activeTerminal[GLOBAL_WORKTREE_ID] : undefined
          if (id) closeGlobalTerminal(id)
        } else if (state.activeWorktreeId) {
          const id = state.activeTerminal[state.activeWorktreeId]
          if (id) disposeTerminal(id)
        }
      }),
      window.api.onMenu('toggle-global-claude', () => {
        const state = useAppStore.getState()
        if (state.project) state.setGlobalPanelOpen(!state.globalPanelOpen)
      }),
      window.api.onMcpCall((request) => void handleMcpCall(request)),
      window.api.onWindowCloseRequest(() => void handleWindowCloseRequest()),
      watchWindowProject(),
      // Attaches null while there is no project, so a reloaded renderer stops the bot it left behind.
      watchBot()
    ]
    return () => unsubscribes.forEach((u) => u())
  }, [openProject])

  // After the listeners above: this also tells main the window can answer a close request.
  useEffect(() => {
    window.api
      .takeInitialWindowState()
      .then(async ({ opened, menu }) => {
        if (opened) useAppStore.getState().setProject(opened.project, opened.filePath)
        if (menu === 'open-project') await openProject()
      })
      .catch(async (err) => {
        syncWindowProject()
        await window.api.showError('Could not open project', String(err))
      })
  }, [openProject])

  const titleBarColor = project?.titleBarColor

  return (
    <div className="app">
      <header
        className={`title-bar ${titleBarColor ? `title-bar-${titleBarForeground(titleBarColor)}` : ''}`}
        style={titleBarColor ? { background: titleBarColor } : undefined}
      >
        <div className="title-side" />
        <span className="title-text">
          {project ? (
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
      {project ? (
        <>
          <Workspace />
          <GlobalClaude />
        </>
      ) : (
        <StartScreen />
      )}
      <SummaryBubble />
    </div>
  )
}
