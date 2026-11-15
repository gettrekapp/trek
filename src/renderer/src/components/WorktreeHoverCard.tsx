import { tagStyle } from '../store'
import { safeStatusColor } from '../plugins/ticketProviders'
import type { DotKind } from '../sidebarRow'
import type { WorktreeTag } from '../../../shared/types'

export interface HoverCardSession {
  key: string
  title: string
  dot: DotKind
  /** "working", "finished", "saved"… */
  word: string
}

export interface HoverCardProps {
  /** Fixed position, from cardAnchor() */
  anchor: { left: number; top: number } | { left: number; bottom: number }
  /** "bugfix/accounts/" — empty for a branch with no folder */
  prefix: string
  name: string
  path: string
  isMain: boolean
  missing: boolean
  /** The workflow tag first, then the custom tags */
  tags: WorktreeTag[]
  ticket?: { label: string; status?: string; statusColor?: string; title?: string }
  pullRequest?: { label: string; watch?: 'watching' | 'paused'; notice?: string }
  /** gitWords() — empty when clean and level */
  git: string
  /** "running — 10.0.0.4" */
  environment?: string
  /** Open decisions' questions */
  questions: string[]
  sessions: HoverCardSession[]
}

/**
 * What a sidebar row no longer spells out, shown beside it after the pointer rests there:
 * the full branch and path, the tags by name, the ticket and PR in words, and each session.
 * It only informs — it takes no pointer events, so it can never be in the way of a click.
 */
export function WorktreeHoverCard(props: HoverCardProps): React.JSX.Element {
  const { ticket, pullRequest } = props
  return (
    <div className="wt-card" role="tooltip" style={props.anchor}>
      <div className="wt-card-head">
        <div className="wt-card-branch">
          {props.prefix && <span className="wt-card-prefix">{props.prefix}</span>}
          {props.name}
        </div>
        <div className="wt-card-path">
          {props.path}
          {props.isMain ? ' · primary checkout' : ''}
        </div>
      </div>
      {props.missing && <div className="wt-card-missing">Git no longer lists this worktree on the server. Delete it to drop it.</div>}
      {props.tags.length > 0 && (
        <div className="wt-card-tags">
          {props.tags.map((t) => (
            <span key={t.id} className="wt-card-tag" style={tagStyle(t)}>
              {t.name}
            </span>
          ))}
        </div>
      )}
      {(ticket || pullRequest || props.git || props.environment) && (
        <dl className="wt-card-facts">
          {ticket && (
            <>
              <dt>Ticket</dt>
              <dd>
                {ticket.label}
                {ticket.status && (
                  <>
                    {' · '}
                    <span className="ticket-status-dot wt-card-status-dot" style={{ background: safeStatusColor(ticket.statusColor) }} />
                    {ticket.status}
                  </>
                )}
                {ticket.title && <div className="wt-card-sub">{ticket.title}</div>}
              </dd>
            </>
          )}
          {pullRequest && (
            <>
              <dt>PR</dt>
              <dd>
                {pullRequest.label}
                {pullRequest.watch === 'watching' && ' · watching'}
                {pullRequest.watch === 'paused' && ' · watch paused'}
                {pullRequest.notice && <div className="wt-card-sub wt-card-notice">{pullRequest.notice}</div>}
              </dd>
            </>
          )}
          {props.git && (
            <>
              <dt>Git</dt>
              <dd>{props.git}</dd>
            </>
          )}
          {props.environment && (
            <>
              <dt>Env</dt>
              <dd>{props.environment}</dd>
            </>
          )}
        </dl>
      )}
      {props.questions.length > 0 && (
        <div className="wt-card-decisions">
          {props.questions.map((q, i) => (
            <div key={i}>Decision: {q}</div>
          ))}
        </div>
      )}
      <div className="wt-card-sessions">
        {props.sessions.length === 0 && <div className="wt-card-none">No sessions</div>}
        {props.sessions.map((s) => (
          <div key={s.key} className={`wt-card-session ${s.dot === 'done' || s.dot === 'attention' ? 'unseen' : ''}`}>
            {s.dot === 'attention' ? <span className="wt-attn">!</span> : <span className={`wt-dot ${s.dot}`} />}
            <span className="wt-card-session-title">{s.title}</span>
            <span className="wt-card-session-word">{s.word}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
