import { useState } from 'react'
import { createPortal } from 'react-dom'
import { repoById, useAppStore } from '../store'
import { ticketFromBranch, ticketLinkPlan, ticketView } from '../../../shared/tickets'
import { useTicketProviders } from '../plugins/useTickets'

interface Props {
  repoId: string
  /** Branch the ticket is associated with (survives promote/delete) */
  branch: string
  onClose: () => void
}

/**
 * Links a branch to a ticket of one of the project's trackers (plugin system phase 2: their
 * plugins' providers), by id or pasted URL. A bare id whose tracker needs a project setting to link
 * (Linear's workspace, Azure DevOps' base URL) asks for it, saved once per project.
 */
export function TicketModal({ repoId, branch, onClose }: Props): React.JSX.Element {
  const project = useAppStore((s) => s.project)!
  const setBranchTicket = useAppStore((s) => s.setBranchTicket)
  const setPluginSetting = useAppStore((s) => s.setPluginSetting)
  const providers = useTicketProviders()
  const settings = project as unknown as Readonly<Record<string, unknown>>

  const currentTicket = repoById(project, repoId)?.branchTickets?.[branch]
  const [input, setInput] = useState(currentTicket ?? ticketFromBranch(providers, branch))
  const [linkValue, setLinkValue] = useState('')
  const [error, setError] = useState<string | null>(null)

  const plan = ticketLinkPlan(providers, settings, input, linkValue)
  const link = plan.link
  const takes = providers.map((p) => p.hint)

  const save = (): void => {
    if (plan.problem || !plan.ticketId) {
      setError(plan.problem)
      return
    }
    for (const [key, value] of Object.entries(plan.settings)) setPluginSetting(key, value, key === link?.key ? link.label : undefined)
    setBranchTicket(repoId, branch, plan.ticketId)
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
          Link branch “{branch}” to a ticket: {takes.length > 0 ? `${takes.join(', or ')}.` : 'no ticket tracker is on in this project (Settings → Plugins).'}
        </p>
        {error && <div className="error">{error}</div>}
        <div className="ticket-fields">
          <input
            type="text"
            autoFocus
            placeholder={providers[0]?.hint ?? ''}
            value={input}
            aria-label="Ticket id or URL"
            onChange={(e) => {
              setInput(e.target.value)
              setError(null)
            }}
            onKeyDown={(e) => {
              onEnter(e)
              if (e.key === 'Escape') onClose()
            }}
          />
          {link && (
            <>
              <input
                type="text"
                aria-label={link.label}
                placeholder={link.placeholder}
                value={linkValue}
                onChange={(e) => {
                  setLinkValue(e.target.value)
                  setError(null)
                }}
                onKeyDown={onEnter}
              />
              <p className="muted ticket-hint">The {link.label.toLowerCase()} is saved once per project and turns ticket ids into links.</p>
            </>
          )}
        </div>
        <div className="modal-footer ticket-footer">
          {currentTicket && (
            <button className="danger-button" onClick={unlink}>
              Unlink {ticketView(providers, settings, currentTicket).label}
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
