import { useState } from 'react'
import { mergedWorktrees, selectedWorktreeInfo, useAppStore } from '../store'
import { useFeatures } from '../useFeatures'
import { Sidebar } from '../components/Sidebar'
import { WorktreeDetail } from '../components/WorktreeDetail'
import { AddWorktreeModal } from '../components/AddWorktreeModal'
import { GlobalClaude } from '../components/GlobalClaude'
import { answerRepoPath, useRepoPathRequest } from './repoPathPrompt'

/**
 * A server project's workspace: the legacy Sidebar, WorktreeDetail and Global
 * panel over the projected slice (applyV2Project fills the store). Unlike the
 * legacy Workspace it polls nothing: the server's mirror patches carry every
 * worktree, git status and session.
 */
export function V2Workspace(): React.JSX.Element {
  const project = useAppStore((s) => s.project)
  const selected = useAppStore((s) => s.selected)
  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)
  const hostWorktrees = useAppStore((s) => s.hostWorktrees)
  const features = useFeatures()
  const [addRepoId, setAddRepoId] = useState<string | null>(null)

  if (!project) return <p className="muted server-window-loading">Loading…</p>
  const worktrees = mergedWorktrees(project, hostWorktrees)
  const info = selectedWorktreeInfo(project, worktrees, selected, activeWorktreeId)
  return (
    <>
      <div className="workspace">
        <Sidebar worktrees={worktrees} onAdd={setAddRepoId} />
        {/* The mirror refreshes the rows by itself after a pull, push or delete. */}
        <WorktreeDetail info={info} worktrees={worktrees} onWorktreesChanged={() => {}} />
        {addRepoId && <AddWorktreeModal repoId={addRepoId} onClose={() => setAddRepoId(null)} />}
        <RepoPathPrompt />
      </div>
      {features.globalPanel && <GlobalClaude />}
    </>
  )
}

/** "Add repository…": the repository is on the server, so its path is typed. */
function RepoPathPrompt(): React.JSX.Element | null {
  const open = useRepoPathRequest()
  const [path, setPath] = useState('')
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
