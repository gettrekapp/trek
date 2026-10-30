import { useState } from 'react'
import { scheduleAutoSave } from '../persistence'
import { allWorktrees, useAppStore } from '../store'
import { sameWorktree } from '../../../shared/types'
import type { GitWorktreeInfo } from '../../../shared/types'

interface Props {
  visible: boolean
  /** Live git worktrees, to mark notes whose worktree no longer exists */
  worktrees: GitWorktreeInfo[]
}

/**
 * Every branch note in the project — including branches whose worktree has
 * since been deleted. Notes are removed with a two-step inline confirm.
 */
export function AllNotesPanel({ visible, worktrees }: Props): React.JSX.Element {
  const branchNotes = useAppStore((s) => s.project?.branchNotes)
  const setBranchNote = useAppStore((s) => s.setBranchNote)
  const [confirming, setConfirming] = useState<string | null>(null)

  const entries = Object.entries(branchNotes ?? {}).sort(([a], [b]) => a.localeCompare(b))
  const worktreeOf = (branch: string): GitWorktreeInfo | undefined =>
    worktrees.find((w) => w.branch === branch)

  const show = (info: GitWorktreeInfo): void => {
    const project = useAppStore.getState().project
    const instance = project
      ? info.isMain && !info.serverId
        ? allWorktrees(project)[0]
        : allWorktrees(project).find((w) => sameWorktree(w, info))
      : undefined
    useAppStore
      .getState()
      .selectWorktree({ serverId: info.serverId, path: info.path }, instance?.id)
  }

  const remove = (branch: string): void => {
    if (confirming !== branch) {
      setConfirming(branch)
      return
    }
    setConfirming(null)
    setBranchNote(branch, '') // empty notes are dropped from the project file
    scheduleAutoSave()
  }

  return (
    <div className="allnotes-panel" style={{ display: visible ? 'flex' : 'none' }}>
      <div className="allnotes-list">
        {entries.length === 0 && (
          <div className="allnotes-empty muted">
            No notes yet. Use the Notes panel on a worktree to write some — they are keyed to
            the branch and collected here.
          </div>
        )}
        {entries.map(([branch, text]) => {
          const info = worktreeOf(branch)
          return (
            <div className="note-card" key={branch}>
              <div className="note-card-header">
                <span className="note-card-branch">
                  <span className="branch-glyph">⎇</span>
                  {branch}
                </span>
                {!info && <span className="note-gone-tag">no worktree</span>}
                <span className="note-card-actions">
                  {info && (
                    <button className="note-card-btn" onClick={() => show(info)}>
                      Show
                    </button>
                  )}
                  <button
                    className={`note-card-btn danger ${confirming === branch ? 'confirming' : ''}`}
                    onMouseLeave={() => {
                      if (confirming === branch) setConfirming(null)
                    }}
                    onClick={() => remove(branch)}
                  >
                    {confirming === branch ? 'Really delete?' : 'Delete'}
                  </button>
                </span>
              </div>
              <div className="note-card-text">{text}</div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
