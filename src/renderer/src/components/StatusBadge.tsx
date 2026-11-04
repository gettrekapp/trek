import type { TerminalStatus } from '../../../shared/types'

const TITLES: Record<TerminalStatus, string> = {
  starting: 'Starting…',
  working: 'Agent is working',
  attention: 'Agent needs your attention',
  done: 'Agent finished',
  complete: 'Marked complete — status tracking paused',
  idle: '',
  exited: 'Process exited'
}

interface Props {
  status: TerminalStatus | null
  /** When set, done/complete badges become a click-to-toggle "fully complete" checkbox. */
  onToggleComplete?: () => void
}

export function StatusBadge({ status, onToggleComplete }: Props): React.JSX.Element | null {
  if (!status || status === 'idle') return null
  if (status === 'starting' || status === 'working') {
    return <span className="badge badge-working" title={TITLES[status]} />
  }
  if (status === 'attention') {
    return (
      <span className="badge badge-attention" title={TITLES.attention}>
        ?
      </span>
    )
  }
  if (status === 'done' || status === 'complete') {
    const clickable = !!onToggleComplete
    const title = clickable
      ? status === 'done'
        ? `${TITLES.done} — click to mark fully complete`
        : `${TITLES.complete} — click to resume tracking`
      : TITLES[status]
    return (
      <span
        className={`badge badge-${status} ${clickable ? 'clickable' : ''}`}
        title={title}
        onClick={
          clickable
            ? (e) => {
                e.stopPropagation()
                onToggleComplete()
              }
            : undefined
        }
      >
        ✓
      </span>
    )
  }
  return (
    <span className="badge badge-exited" title={TITLES.exited}>
      ✕
    </span>
  )
}
