import { useCallback, useEffect } from 'react'
import { GLOBAL_WORKTREE_ID, useAppStore } from './store'
import { saveProject } from './persistence'
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
import { useLinearSync } from './linear'
import { loadVoiceSettings } from './voice'
import { SummaryBubble } from './components/SummaryBubble'

export default function App(): React.JSX.Element {
  const project = useAppStore((s) => s.project)
  const filePath = useAppStore((s) => s.filePath)
  const dirty = useAppStore((s) => s.dirty)
  useLinearSync()

  useEffect(() => {
    void loadVoiceSettings()
  }, [])

  const openProject = useCallback(async (): Promise<void> => {
    const opened = await window.api.openProject()
    if (!opened) return
    disposeAllTerminals()
    // Worktrees open unloaded — the sidebar loads each one's saved sessions on
    // demand, so a project with dozens of them doesn't launch dozens of claudes.
    useAppStore.getState().setProject(opened.project, opened.filePath)
  }, [])

  const newProject = useCallback((): void => {
    disposeAllTerminals()
    useAppStore.getState().closeProject()
  }, [])

  useEffect(() => {
    const unsubscribes = [
      window.api.onMenu('save-project', () => void saveProject()),
      window.api.onMenu('open-project', () => void openProject()),
      window.api.onMenu('new-project', newProject),
      window.api.onMenu('new-terminal', () => {
        const state = useAppStore.getState()
        if (state.project && state.selected) void startClaudeSession(state.selected)
      }),
      window.api.onMenu('close-tab', () => {
        const state = useAppStore.getState()
        if (focusInGlobalPanel()) {
          const id = state.activeTerminal[GLOBAL_WORKTREE_ID]
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
      window.api.onMcpCall((request) => void handleMcpCall(request))
    ]
    return () => unsubscribes.forEach((u) => u())
  }, [openProject, newProject])

  return (
    <div className="app">
      <header className="title-bar">
        <div className="title-side" />
        <span className="title-text">
          {project ? (
            <>
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
