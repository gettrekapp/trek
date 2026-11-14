import { useEffect, useState } from 'react'
import { GLOBAL_WORKTREE_ID, mergedWorktrees, selectedWorktreeInfo, useAppStore } from '../store'
import { globalPanelMode } from '../backendFeatures'
import { useFeatures } from '../useFeatures'
import { getBackend } from '../backend'
import { useEnvironmentPoll } from '../useEnvironmentPoll'
import { Sidebar } from '../components/Sidebar'
import { WorktreeDetail } from '../components/WorktreeDetail'
import { AddWorktreeModal } from '../components/AddWorktreeModal'
import { GlobalClaude } from '../components/GlobalClaude'
import { MissedRunsModal } from '../components/MissedRunsModal'
import { SettingsPanel } from '../components/SettingsPanel'
import { AutomationsPanel } from '../components/AutomationsPanel'
import { answerRepoPath, cancelRepoPath, useRepoPathRequest } from './repoPathPrompt'

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

  // The link dropped: a focused field or button must not take Enter or typing meanwhile.
  useEffect(() => {
    if (offline && document.activeElement instanceof HTMLElement) document.activeElement.blur()
  }, [offline])

  // A page opened over the detail: the terminal under it must not keep taking typing.
  useEffect(() => {
    if (projectPage && document.activeElement instanceof HTMLElement) document.activeElement.blur()
  }, [projectPage])

  if (!project) return <p className="muted server-window-loading">Loading…</p>
  const worktrees = mergedWorktrees(project, hostWorktrees)
  const info = selectedWorktreeInfo(project, worktrees, selected, activeWorktreeId)
  return (
    <>
      <div className="workspace">
        <Sidebar worktrees={worktrees} onAdd={setAddRepoId} />
        {/* The project-level pages cover the detail, which stays mounted under them. */}
        <div className="workspace-main">
          {/* The mirror refreshes the rows by itself after a pull, push or delete. */}
          <WorktreeDetail info={info} worktrees={worktrees} onWorktreesChanged={() => {}} />
          {features.settingsEdit && <SettingsPanel visible={projectPage === 'settings'} />}
          {features.automations && <AutomationsPanel visible={projectPage === 'automations'} />}
        </div>
        {addRepoId && <AddWorktreeModal repoId={addRepoId} onClose={() => setAddRepoId(null)} />}
        <RepoPathPrompt />
      </div>
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
