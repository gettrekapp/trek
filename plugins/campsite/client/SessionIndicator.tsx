// A session tab's hiker, in place of the status dot. Done or complete with a toggle: clicking it
// marks complete (or resumes tracking), as the dot did. The tab names the session, so the hiker is
// decorative; the title says its status. Before (or after) the host lists the session, the hiker
// draws from the tab's own status, so the tab is never blank.
import { useMemo } from 'react'
import { usePluginHost, type SessionIndicatorProps } from '../../../src/shared/plugins/client.ts'
import { lookFor } from '../shared/hiker.ts'
import { SIGN_TEXT, choreFor, indicatorState, indicatorTitle, stanceFor, statusText } from '../shared/pose.ts'
import { Hiker } from './Hiker.tsx'
import { useNow, useSession } from './hooks.ts'

export function SessionIndicator({ terminalId, status, onToggleComplete }: SessionIndicatorProps): React.JSX.Element {
  const host = usePluginHost()
  const session = useSession(host, terminalId)
  const now = useNow()
  const provider = session?.provider ?? 'claude'
  const look = useMemo(() => lookFor(terminalId, provider), [terminalId, provider])
  const state = indicatorState(session, status)
  const stance = stanceFor(state, choreFor(terminalId, now))
  const toggle = state.status === 'done' || state.status === 'complete' ? onToggleComplete : undefined
  return (
    <span
      className={`cs-indicator${toggle ? ' clickable' : ''}`}
      title={indicatorTitle(state, !!toggle)}
      onClick={
        toggle
          ? (e) => {
              e.stopPropagation()
              toggle()
            }
          : undefined
      }
    >
      <Hiker look={look} pose={stance.pose} gear={stance.gear} grey={stance.grey} scale={1} label={`${session?.label ?? host.terminalLabel(terminalId)}, ${statusText(state)}`} decorative />
      {stance.sign && (
        <span className={`cs-tab-sign ${stance.sign}`} aria-hidden="true">
          {SIGN_TEXT[stance.sign]}
        </span>
      )}
    </span>
  )
}
