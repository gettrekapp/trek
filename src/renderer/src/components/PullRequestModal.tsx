import { useState } from 'react'
import { createPortal } from 'react-dom'
import { scheduleAutoSave } from '../persistence'
import { useAppStore } from '../store'

interface Props {
  repoId: string
  /** Branch the pull request is associated with (survives promote/delete) */
  branch: string
  onClose: () => void
}

/** Links a branch to a GitHub pull request by URL. */
export function PullRequestModal({ repoId, branch, onClose }: Props): React.JSX.Element {
  const currentUrl = useAppStore(
    (s) => s.project?.repositories.find((r) => r.id === repoId)?.branchPullRequests?.[branch]
  )
  const setBranchPullRequest = useAppStore((s) => s.setBranchPullRequest)
  const [input, setInput] = useState(currentUrl ?? '')
  const [error, setError] = useState<string | null>(null)

  const save = (): void => {
    const url = input.trim()
    if (!/^https?:\/\/\S+$/i.test(url)) {
      setError('Paste the pull request URL, e.g. https://github.com/org/repo/pull/123')
      return
    }
    setBranchPullRequest(repoId, branch, url)
    scheduleAutoSave()
    onClose()
  }

  const unlink = (): void => {
    setBranchPullRequest(repoId, branch, null)
    scheduleAutoSave()
    onClose()
  }

  return createPortal(
    <div className="modal-backdrop" onMouseDown={onClose} onClick={(e) => e.stopPropagation()}>
      <div className="modal ticket-modal" onMouseDown={(e) => e.stopPropagation()}>
        <h2>GitHub Pull Request</h2>
        <p className="muted">Link branch “{branch}” to a pull request.</p>
        {error && <div className="error">{error}</div>}
        <div className="ticket-fields">
          <input
            type="text"
            autoFocus
            placeholder="https://github.com/org/repo/pull/123"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') save()
              if (e.key === 'Escape') onClose()
            }}
          />
        </div>
        <div className="modal-footer ticket-footer">
          {currentUrl && (
            <button className="danger-button" onClick={unlink}>
              Unlink
            </button>
          )}
          <span className="ticket-footer-spacer" />
          <button onClick={onClose}>Cancel</button>
          <button className="primary-action" onClick={save}>
            Save
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
