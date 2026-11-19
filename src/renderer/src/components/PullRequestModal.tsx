import { useState } from 'react'
import { createPortal } from 'react-dom'
import { useAppStore } from '../store'
import { usePrProviders } from '../plugins/usePrProviders'
import { prLinkToSave } from '../../../shared/plugins/pullRequests.ts'

interface Props {
  repoId: string
  /** Branch the pull request is associated with (survives promote/delete) */
  branch: string
  onClose: () => void
}

/** Links a branch to a pull request by its link. */
export function PullRequestModal({ repoId, branch, onClose }: Props): React.JSX.Element {
  const currentUrl = useAppStore(
    (s) => s.project?.repositories.find((r) => r.id === repoId)?.branchPullRequests?.[branch]
  )
  const setBranchPullRequest = useAppStore((s) => s.setBranchPullRequest)
  const [input, setInput] = useState(currentUrl ?? '')
  const [error, setError] = useState<string | null>(null)
  const providers = usePrProviders()

  const save = (): void => {
    // An unchanged link closes as is, even one the window's providers can't read (stored before, or its provider is off).
    if (currentUrl && input.trim() === currentUrl) {
      onClose()
      return
    }
    // A provider's canonical form, or any other http(s) link as typed (generic chip, no watch).
    const url = prLinkToSave(providers, input)
    if (!url) {
      setError(
        providers.length === 0
          ? 'No pull request provider is on in this project (Settings → Plugins).'
          : `Enter ${providers.map((p) => p.hint).join(', or ')}`
      )
      return
    }
    setBranchPullRequest(repoId, branch, url)
    onClose()
  }

  const unlink = (): void => {
    setBranchPullRequest(repoId, branch, null)
    onClose()
  }

  return createPortal(
    <div className="modal-backdrop" onMouseDown={onClose} onClick={(e) => e.stopPropagation()}>
      <div className="modal ticket-modal" onMouseDown={(e) => e.stopPropagation()}>
        <h2>Pull Request</h2>
        <p className="muted">Link branch “{branch}” to a pull request.</p>
        {error && <div className="error">{error}</div>}
        <div className="ticket-fields">
          <input
            type="text"
            autoFocus
            placeholder={providers[0]?.hint ?? ''}
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
