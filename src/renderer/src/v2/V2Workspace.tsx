import { useEffect, useState } from 'react'
import { GLOBAL_WORKTREE_ID, mergedWorktrees, selectedWorktreeInfo, useAppStore } from '../store'
import { globalPanelMode } from '../backendFeatures'
import { useFeatures } from '../useFeatures'
import { getBackend } from '../backend'
import { useEnvironmentPoll } from '../useEnvironmentPoll'
import { Sidebar } from '../components/Sidebar'
import { toggleSidebar } from '../sidebarToggle'
import { WorktreeDetail } from '../components/WorktreeDetail'
import { AddWorktreeModal } from '../components/AddWorktreeModal'
import { GlobalClaude } from '../components/GlobalClaude'
import { MissedRunsModal } from '../components/MissedRunsModal'
import { SettingsPanel } from '../components/SettingsPanel'
import { AllNotesPanel } from '../components/AllNotesPanel'
import { AutomationsPanel } from '../components/AutomationsPanel'
import { PluginSlot } from '../plugins/PluginHost'
import { answerRepoPath, cancelRepoPath, useRepoPathRequest } from './repoPathPrompt'
import { defaultTeardown, teardownBlocking } from '../../../shared/teardown'
import { usePluginEntries } from '../plugins/PluginHost'
import { answerTeardown, cancelTeardown, teardownHeld, uncheckedName, useTeardownQuestion, type TeardownQuestion } from './teardownPrompt'

/**
 * A server project's workspace: the Sidebar, WorktreeDetail and Global panel
 * over the projected slice (applyV2Project fills the store). It polls no git:
 * the server's mirror patches carry every worktree, git status and session. A
 * window whose server runs the environments (`features.env`, any 5a server)
 * polls them, on the server's machine.
 */
export function V2Workspace(): React.JSX.Element {
  const project = useAppStore((s) => s.project)
  const selected = useAppStore((s) => s.selected)
  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)
  const hostWorktrees = useAppStore((s) => s.hostWorktrees)
  const features = useFeatures()
  const [addRepoId, setAddRepoId] = useState<string | null>(null)
  const offline = useAppStore((s) => s.serverOffline)
  const sidebarHidden = useAppStore((s) => s.sidebarHidden)
  const projectPage = useAppStore((s) => s.projectPage)
  const globalTabs = useAppStore((s) => s.terminalOrder[GLOBAL_WORKTREE_ID]?.length ?? 0)
  const globalMode = globalPanelMode(features, globalTabs)
  useEnvironmentPoll(features.env)
  // promote_to_primary (5e): an agent's request shows this window's promote confirmation. Started
  // here, once the window's connection exists, by the first render with the feature; the backend
  // keeps its one follower until the window leaves the project (a reconnect's new welcome, or this
  // workspace re-mounting, never drops a request or its open dialog).
  const promote = features.promote
  const backend = getBackend()
  useEffect(() => {
    if (promote) backend.worktrees.followPromoteRequests()
  }, [promote, backend])
  // What this window shows, for get_selected_worktree, and focus_session's requests: started the
  // same way, and kept by the backend until the window leaves the project.
  const ui = features.ui
  useEffect(() => {
    if (ui) backend.worktrees.followSelection()
  }, [ui, backend])

  // The link dropped: a focused field or button must not take Enter or typing meanwhile.
  useEffect(() => {
    if (offline && document.activeElement instanceof HTMLElement) document.activeElement.blur()
  }, [offline])

  // A page opened over the detail: a field under it must not keep taking typing. The row that
  // opened it keeps its focus, so the keyboard can close it again.
  useEffect(() => {
    const focused = document.activeElement
    if (projectPage && focused instanceof HTMLElement && focused.closest('.detail')) focused.blur()
  }, [projectPage])

  if (!project) return <p className="muted server-window-loading">Loading…</p>
  const worktrees = mergedWorktrees(project, hostWorktrees)
  const info = selectedWorktreeInfo(project, worktrees, selected, activeWorktreeId)
  return (
    <>
      <div className={sidebarHidden ? 'workspace sidebar-hidden' : 'workspace'}>
        {sidebarHidden && (
          <div className="sidebar-rail">
            <button className="sidebar-toggle sidebar-show" title="Show sidebar" aria-label="Show sidebar" onClick={toggleSidebar}>
              »
            </button>
          </div>
        )}
        {/* Hidden by the stylesheet, not unmounted: its filter and collapsed sections are there when it comes back. */}
        <Sidebar worktrees={worktrees} onAdd={setAddRepoId} />
        {/* The project-level pages cover the detail, which stays mounted under them. */}
        <div className="workspace-main">
          {/* The mirror refreshes the rows by itself after a pull, push or delete. */}
          <WorktreeDetail info={info} onWorktreesChanged={() => {}} />
          <AllNotesPanel visible={projectPage === 'notes'} worktrees={worktrees} />
          {features.settingsEdit && <SettingsPanel visible={projectPage === 'settings'} />}
          {features.automations && <AutomationsPanel visible={projectPage === 'automations'} />}
        </div>
        {addRepoId && <AddWorktreeModal repoId={addRepoId} onClose={() => setAddRepoId(null)} />}
        <RepoPathPrompt />
        <TeardownPrompt />
      </div>
      <PluginSlot name="bottomBar" />
      {globalMode !== 'hidden' && <GlobalClaude readOnly={globalMode === 'readOnly'} />}
      {features.automations && <MissedRunsModal />}
    </>
  )
}

/** "Add repository…": the repository is on the server, so its path is typed. */
function RepoPathPrompt(): React.JSX.Element | null {
  const open = useRepoPathRequest()
  const [path, setPath] = useState('')
  // Gone with the workspace (Pick another project, Server removed): the request ends with null.
  useEffect(() => cancelRepoPath, [])
  if (!open) return null
  const answer = (value: string | null): void => {
    setPath('')
    answerRepoPath(value)
  }
  return (
    <div className="modal-backdrop" onMouseDown={() => answer(null)}>
      <div className="modal repo-path-prompt" onMouseDown={(e) => e.stopPropagation()}>
        <h2>Add repository</h2>
        <p className="muted">The path of a git repository on the server, under one of its allowed roots.</p>
        <div className="create-row">
          <label className="visually-hidden" htmlFor="repo-path-input">
            Repository path on the server
          </label>
          <input
            id="repo-path-input"
            type="text"
            placeholder="/home/dev/repos/app"
            value={path}
            autoFocus
            spellCheck={false}
            onChange={(e) => setPath(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && path.trim()) answer(path)
              if (e.key === 'Escape') answer(null)
            }}
          />
          <button className="primary" disabled={!path.trim()} onClick={() => answer(path)}>
            Add
          </button>
        </div>
        <div className="modal-footer">
          <button onClick={() => answer(null)}>Cancel</button>
        </div>
      </div>
    </div>
  )
}

/** A delete's or promote's teardown confirm (plugins E3): a checkbox per item the server plans. */
function TeardownPrompt(): React.JSX.Element | null {
  const question = useTeardownQuestion()
  // Gone with the workspace (Pick another project, Server removed): the question ends cancelled.
  useEffect(() => () => cancelTeardown(), [])
  if (!question) return null
  return <TeardownDialog key={question.id} question={question} />
}

function TeardownDialog({ question }: { question: TeardownQuestion }): React.JSX.Element {
  const { prompt, items, unplanned } = question
  const [ticked, setTicked] = useState<ReadonlySet<string>>(() => new Set(defaultTeardown(items)))
  // Past the participants the server could not ask, on purpose (their plan failed).
  const [withoutUnplanned, setWithoutUnplanned] = useState(false)
  const pluginEntries = usePluginEntries()
  const nameOf = (id: string): string => pluginEntries.find((e) => e.plugin.manifest.id === id)?.plugin.manifest.name ?? id
  const unchecked = unplanned.map((id) => uncheckedName(id, nameOf))
  const blocking = teardownBlocking(items, ticked)
  const held = teardownHeld(question, ticked, withoutUnplanned)
  const tick = (id: string, on: boolean): void =>
    setTicked((prev) => {
      const next = new Set(prev)
      if (on) next.add(id)
      else next.delete(id)
      return next
    })
  const cancel = (): void => answerTeardown(false, ticked)
  // Escape cancels wherever the focus is (Confirm may start disabled, so nothing in the dialog has it).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') answerTeardown(false, new Set())
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  return (
    <div className="modal-backdrop" onMouseDown={cancel}>
      <div
        className="modal teardown-prompt"
        role="dialog"
        aria-modal="true"
        aria-label={prompt.title}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h2>{prompt.title}</h2>
        <p className="teardown-message">{prompt.message}</p>
        {prompt.detail && <p className="muted teardown-detail">{prompt.detail}</p>}
        <ul className="teardown-items">
          {items.map((item) => (
            <li key={item.id} className={blocking.includes(item.id) ? 'warn' : undefined}>
              <label className="teardown-item">
                <input type="checkbox" checked={ticked.has(item.id)} onChange={(e) => tick(item.id, e.target.checked)} /> {item.label}
              </label>
              {blocking.includes(item.id) && ' It is running: stop it first, or tick this.'}
            </li>
          ))}
          {unchecked.length > 0 && (
            <li className="warn teardown-unchecked">
              This server could not check what {unchecked.join(' and ')} would tear down, so {unchecked.length > 1 ? 'they' : 'it'} may be left running.
              Cancel and try again, or go ahead without {unchecked.length > 1 ? 'them' : 'it'}.
              <label className="teardown-item">
                <input type="checkbox" checked={withoutUnplanned} onChange={(e) => setWithoutUnplanned(e.target.checked)} /> Go ahead without{' '}
                {unchecked.length > 1 ? 'them' : 'it'}
              </label>
            </li>
          )}
        </ul>
        <div className="modal-footer">
          <button onClick={cancel}>Cancel</button>
          <button className="primary" autoFocus disabled={held} onClick={() => answerTeardown(true, ticked, withoutUnplanned)}>
            {prompt.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
