import { useState } from 'react'
import { createPortal } from 'react-dom'
import { isLinearTicket, parseTicket, repoById, ticketLabel, useAppStore } from '../store'

interface Props {
  repoId: string
  /** Branch the ticket is associated with (survives promote/delete) */
  branch: string
  onClose: () => void
}

/** Linear's default branch names embed the issue id, e.g. "garrett/tow-123-fix-login". */
function ticketFromBranch(branch: string): string {
  const match = branch.match(/(?:^|\/)([a-z][a-z0-9]*-\d+)(?:-|$)/i)
  return match ? match[1].toUpperCase() : ''
}

/**
 * Links a branch to a Linear issue or an Azure DevOps work item, by
 * identifier or pasted URL.
 */
export function TicketModal({ repoId, branch, onClose }: Props): React.JSX.Element {
  const project = useAppStore((s) => s.project)!
  const setBranchTicket = useAppStore((s) => s.setBranchTicket)
  const setAzureDevOpsBaseUrl = useAppStore((s) => s.setAzureDevOpsBaseUrl)
  const setLinearWorkspace = useAppStore((s) => s.setLinearWorkspace)

  const currentTicket = repoById(project, repoId)?.branchTickets?.[branch]
  const [input, setInput] = useState(currentTicket ?? ticketFromBranch(branch))
  const [baseUrl, setBaseUrl] = useState(project.azureDevOpsBaseUrl ?? '')
  const [workspace, setWorkspace] = useState(project.linearWorkspace ?? '')
  const [error, setError] = useState<string | null>(null)

  const parsed = parseTicket(input)
  // Pasted URLs supply the workspace/base URL themselves; bare ids need it saved once.
  const bareLinear = !!parsed && isLinearTicket(parsed.ticketId) && !parsed.linearWorkspace
  const bareAdo = !!parsed && !isLinearTicket(parsed.ticketId) && !parsed.azureDevOpsBaseUrl
  const needsWorkspace = bareLinear && !project.linearWorkspace
  const needsBaseUrl = bareAdo && !project.azureDevOpsBaseUrl

  const save = (): void => {
    if (!parsed) {
      setError('Enter a Linear issue id (e.g. TOW-123), a work item id, or paste the ticket URL.')
      return
    }
    const ws = parsed.linearWorkspace ?? workspace.trim()
    const base = parsed.azureDevOpsBaseUrl ?? baseUrl.trim()
    if (ws && ws !== project.linearWorkspace) setLinearWorkspace(ws)
    if (base && base !== project.azureDevOpsBaseUrl) setAzureDevOpsBaseUrl(base)
    setBranchTicket(repoId, branch, parsed.ticketId)
    onClose()
  }

  const unlink = (): void => {
    setBranchTicket(repoId, branch, null)
    onClose()
  }

  const onEnter = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter') save()
  }

  return createPortal(
    <div
      className="modal-backdrop"
      onMouseDown={onClose}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="modal ticket-modal" onMouseDown={(e) => e.stopPropagation()}>
        <h2>Ticket</h2>
        <p className="muted">
          Link branch “{branch}” to a Linear issue. Enter its id or paste the issue URL.
        </p>
        {error && <div className="error">{error}</div>}
        <div className="ticket-fields">
          <input
            type="text"
            autoFocus
            placeholder="TOW-123 or https://linear.app/trek/issue/TOW-123"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              onEnter(e)
              if (e.key === 'Escape') onClose()
            }}
          />
          {needsWorkspace && (
            <>
              <input
                type="text"
                placeholder="Linear workspace, e.g. trek (from linear.app/trek/…)"
                value={workspace}
                onChange={(e) => setWorkspace(e.target.value)}
                onKeyDown={onEnter}
              />
              <p className="muted ticket-hint">
                The workspace is saved once per project and turns issue ids into links.
              </p>
            </>
          )}
          {needsBaseUrl && (
            <>
              <input
                type="text"
                placeholder="Azure DevOps base URL, e.g. https://dev.azure.com/trek/Trek"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                onKeyDown={onEnter}
              />
              <p className="muted ticket-hint">
                The base URL is saved once per project and turns work item ids into links.
              </p>
            </>
          )}
        </div>
        <div className="modal-footer ticket-footer">
          {currentTicket && (
            <button className="danger-button" onClick={unlink}>
              Unlink {ticketLabel(currentTicket)}
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
