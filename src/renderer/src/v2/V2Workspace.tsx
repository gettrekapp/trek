import { useEffect, useId, useRef, useState } from 'react'
import { GLOBAL_WORKTREE_ID, mergedWorktrees, selectedWorktreeInfo, useAppStore } from '../store'
import { globalPanelMode } from '../backendFeatures'
import { useFeatures } from '../useFeatures'
import { getBackend } from '../backend'
import { Sidebar } from '../components/Sidebar'
import { toggleSidebar } from '../sidebarToggle'
import { WorktreeDetail } from '../components/WorktreeDetail'
import { AddWorktreeModal } from '../components/AddWorktreeModal'
import { GlobalSessions } from '../components/GlobalSessions'
import { MissedRunsModal } from '../components/MissedRunsModal'
import { SettingsPanel } from '../components/SettingsPanel'
import { AllNotesPanel } from '../components/AllNotesPanel'
import { AutomationsPanel } from '../components/AutomationsPanel'
import { PluginSlot } from '../plugins/PluginHost'
import { answerRepoPath, cancelRepoPath, useRepoPathRequest } from './repoPathPrompt'
import { defaultTeardown, teardownBlocking } from '../../../shared/teardown'
import { usePluginEntries } from '../plugins/PluginHost'
import { answerTeardown, hostTeardownPrompt, teardownHeld, uncheckedText, useTeardownQuestion, type TeardownQuestion } from './teardownPrompt'

/**
 * A server project's workspace: the Sidebar, WorktreeDetail and Global panel
 * over the projected slice (applyV2Project fills the store). It polls no git:
 * the server's mirror patches carry every worktree, git status and session.
 * The plugins' Runtimes poll what they need (the Colima environments: the env
 * plugin's).
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

  // The teardown confirm is up while loading too: an agent's promote request that comes then waits for it.
  if (!project)
    return (
      <>
        <p className="muted server-window-loading">Loading…</p>
        <TeardownPrompt />
      </>
    )
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
      {globalMode !== 'hidden' && <GlobalSessions readOnly={globalMode === 'readOnly'} />}
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

/**
 * A delete's or promote's teardown confirm (plugins E3): a checkbox per item the server plans. While
 * it is mounted the questions show (teardownPrompt.ts); with none mounted a new one is cancelled at
 * once. It does not cancel the queued ones as it goes: installV2's leave() does, and a remount
 * shows them again.
 */
function TeardownPrompt(): React.JSX.Element | null {
  const question = useTeardownQuestion()
  useEffect(() => hostTeardownPrompt(), [])
  if (!question) return null
  return <TeardownDialog key={question.id} question={question} />
}

/** Another overlay over the dialog (the web client's dialogs) takes Escape for itself. */
const OVERLAYS = '.web-dialog-backdrop'

function TeardownDialog({ question }: { question: TeardownQuestion }): React.JSX.Element {
  const { id, prompt, items, unplanned } = question
  const [ticked, setTicked] = useState<ReadonlySet<string>>(() => new Set(defaultTeardown(items)))
  // Past the participants the server could not ask, on purpose (their plan failed).
  const [withoutUnplanned, setWithoutUnplanned] = useState(false)
  const pluginEntries = usePluginEntries()
  const nameOf = (participant: string): string => pluginEntries.find((e) => e.plugin.manifest.id === participant)?.plugin.manifest.name ?? participant
  const warning = uncheckedText(unplanned, nameOf)
  const blocking = teardownBlocking(items, ticked)
  const held = teardownHeld(question, ticked, withoutUnplanned)
  const ids = useId()
  const dialog = useRef<HTMLDivElement>(null)
  const confirmButton = useRef<HTMLButtonElement>(null)
  const tick = (itemId: string, on: boolean): void =>
    setTicked((prev) => {
      const next = new Set(prev)
      if (on) next.add(itemId)
      else next.delete(itemId)
      return next
    })
  const cancel = (): void => answerTeardown(id, false, ticked)

  // The dialog takes the focus (a terminal must not keep the typing): the first checkbox (an
  // item's, or "Go ahead without it" with no items), else Confirm. It goes back where it was after.
  useEffect(() => {
    const before = document.activeElement
    const first = dialog.current?.querySelector<HTMLInputElement>('input[type=checkbox]')
    ;(first ?? confirmButton.current ?? dialog.current)?.focus()
    return () => {
      if (before instanceof HTMLElement && before.isConnected && (document.activeElement === document.body || document.activeElement === null)) before.focus()
    }
  }, [])
  // Escape cancels, taken in the capture phase so a terminal never sees it; not while another
  // overlay is over the dialog, or the focus is somewhere else (a menu).
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || document.querySelector(OVERLAYS)) return
      const focused = document.activeElement
      if (focused && focused !== document.body && !dialog.current?.contains(focused)) return
      e.preventDefault()
      e.stopPropagation()
      answerTeardown(id, false, new Set())
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [id])

  const titleId = `${ids}-title`
  const messageId = `${ids}-message`
  const detailId = `${ids}-detail`
  return (
    <div className="modal-backdrop" onMouseDown={cancel}>
      <div
        ref={dialog}
        className="modal teardown-prompt"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={prompt.detail ? `${messageId} ${detailId}` : messageId}
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          // Enter confirms only on Confirm itself, and never while it is disabled.
          if (e.key === 'Enter' && !(e.target instanceof HTMLButtonElement)) e.preventDefault()
        }}
      >
        <h2 id={titleId}>{prompt.title}</h2>
        <p id={messageId} className="teardown-message">
          {prompt.message}
        </p>
        {prompt.detail && (
          <p id={detailId} className="muted teardown-detail">
            {prompt.detail}
          </p>
        )}
        <ul className="teardown-items">
          {items.map((item, i) => {
            const runningId = `${ids}-running-${i}`
            const blocks = blocking.includes(item.id)
            return (
              <li key={item.id} className={blocks ? 'warn' : undefined}>
                <label className="teardown-item">
                  <input
                    type="checkbox"
                    checked={ticked.has(item.id)}
                    aria-describedby={blocks ? runningId : undefined}
                    onChange={(e) => tick(item.id, e.target.checked)}
                  />{' '}
                  {item.label}
                </label>
                {blocks && <span id={runningId}> It is running: stop it first, or tick this.</span>}
              </li>
            )
          })}
          {warning && (
            <li className="warn teardown-unchecked">
              <span id={`${ids}-unchecked`}>{warning}</span>
              <label className="teardown-item">
                <input
                  type="checkbox"
                  checked={withoutUnplanned}
                  aria-describedby={`${ids}-unchecked`}
                  onChange={(e) => setWithoutUnplanned(e.target.checked)}
                />{' '}
                Go ahead without {unplanned.length > 1 ? 'them' : 'it'}
              </label>
            </li>
          )}
        </ul>
        <div className="modal-footer">
          <button onClick={cancel}>Cancel</button>
          <button ref={confirmButton} className="primary" disabled={held} onClick={() => answerTeardown(id, true, ticked, withoutUnplanned)}>
            {prompt.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
