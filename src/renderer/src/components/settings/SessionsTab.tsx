import { useAppStore } from '../../store'
import { SettingText } from '../SettingText'
import { QuickButtonsEditor } from './QuickButtonsEditor'

/** Settings → Sessions: the worktree sessions' prompt and buttons, then the Global session's. */
export function SessionsTab(): React.JSX.Element {
  // Defaults applied outside the selectors — `?? []` inside one would return a
  // fresh array every snapshot and loop React's store re-render (error #185).
  const terminalButtons = useAppStore((s) => s.project?.terminalButtons) ?? []
  const setTerminalButtons = useAppStore((s) => s.setTerminalButtons)
  const globalTerminalButtons = useAppStore((s) => s.project?.globalTerminalButtons) ?? []
  const setGlobalTerminalButtons = useAppStore((s) => s.setGlobalTerminalButtons)
  const globalSystemPrompt = useAppStore((s) => s.project?.globalSystemPrompt) ?? ''
  const setGlobalSystemPrompt = useAppStore((s) => s.setGlobalSystemPrompt)
  const sessionSystemPrompt = useAppStore((s) => s.project?.sessionSystemPrompt) ?? ''
  const setSessionSystemPrompt = useAppStore((s) => s.setSessionSystemPrompt)

  return (
    <>
      <h3>Session system prompt</h3>
      <div className="settings-row">
        <span className="settings-label">
          <span className="settings-desc">
            Appended to the system prompt of every worktree session, after its session
            type&apos;s prompt (--append-system-prompt). Not used by the global session.
            Takes effect the next time each session starts or resumes.
          </span>
        </span>
      </div>
      <div className="settings-row">
        <SettingText
          rows={6}
          className="quick-btn-text-input session-prompt-input"
          placeholder="e.g. Run the unit tests before saying a change is done"
          value={sessionSystemPrompt}
          onCommit={setSessionSystemPrompt}
        />
      </div>
      <h3>Terminal quick buttons</h3>
      <QuickButtonsEditor
        description="Buttons shown under every worktree agent terminal. Clicking one fills the terminal's input with the text and submits it."
        buttons={terminalButtons}
        onChange={setTerminalButtons}
      />
      <h3>Global system prompt</h3>
      <div className="settings-row">
        <span className="settings-label">
          <span className="settings-desc">
            Appended to the global session&apos;s system prompt (--append-system-prompt).
            Takes effect the next time the session starts, e.g. after restarting the app or
            starting a new conversation.
          </span>
        </span>
      </div>
      <div className="settings-row">
        <SettingText
          rows={6}
          className="quick-btn-text-input"
          placeholder="e.g. Prefer starting Review sessions for finished worktrees"
          value={globalSystemPrompt}
          onCommit={setGlobalSystemPrompt}
        />
      </div>
      <h3>Global quick buttons</h3>
      <QuickButtonsEditor
        description="Buttons shown under the global terminal at the bottom of the window."
        buttons={globalTerminalButtons}
        onChange={setGlobalTerminalButtons}
      />
    </>
  )
}
