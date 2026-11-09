import { useState } from 'react'
import { instanceForInfo, useAppStore } from '../store'
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
  const repositories = useAppStore((s) => s.project?.repositories) ?? []
  const setBranchNote = useAppStore((s) => s.setBranchNote)
  const [confirming, setConfirming] = useState<string | null>(null)

  const hasNotes = repositories.some((r) => Object.keys(r.branchNotes ?? {}).length > 0)

  const show = (info: GitWorktreeInfo): void => {
    const project = useAppStore.getState().project
    const instance = project ? instanceForInfo(project, info) : undefined
    useAppStore
      .getState()
      .selectWorktree({ path: info.path }, instance?.id)
  }

  const remove = (repoId: string, branch: string): void => {
    const key = `${repoId} ${branch}`
    if (confirming !== key) {
      setConfirming(key)
      return
    }
    setConfirming(null)
    setBranchNote(repoId, branch, '') // an empty note is removed on the server
  }

  return (
    <div className="allnotes-panel" style={{ display: visible ? 'flex' : 'none' }}>
      <div className="allnotes-list">
        {!hasNotes && (
          <div className="allnotes-empty muted">
            No notes yet. Use the Notes panel on a worktree to write some — they are keyed to
            the branch and collected here.
          </div>
        )}
        {repositories.map((repo) => {
          const entries = Object.entries(repo.branchNotes ?? {}).sort(([a], [b]) =>
            a.localeCompare(b)
          )
          if (entries.length === 0) return null
          return (
            <div key={repo.id}>
              {repositories.length > 1 && <h4 className="allnotes-repo">{repo.name}</h4>}
              {entries.map(([branch, text]) => {
                const info = worktrees.find((w) => w.repoId === repo.id && w.branch === branch)
                const key = `${repo.id} ${branch}`
                return (
                  <div className="note-card" key={key}>
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
                          className={`note-card-btn danger ${confirming === key ? 'confirming' : ''}`}
                          onMouseLeave={() => {
                            if (confirming === key) setConfirming(null)
                          }}
                          onClick={() => remove(repo.id, branch)}
                        >
                          {confirming === key ? 'Really delete?' : 'Delete'}
                        </button>
                      </span>
                    </div>
                    <div className="note-card-text">{text}</div>
                  </div>
                )
              })}
            </div>
          )
        })}
      </div>
    </div>
  )
}
