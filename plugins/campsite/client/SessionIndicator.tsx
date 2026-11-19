// A session tab's hiker, in place of the status dot. Done or complete with a toggle: clicking it
// marks complete (or resumes tracking), as the dot did. The tab names the session, so the hiker is
// decorative; the title says its status.
import { useMemo } from 'react'
import { usePluginHost, type SessionIndicatorProps } from '../../../src/shared/plugins/client.ts'
import { lookFor } from '../shared/hiker.ts'
import { choreFor, hikerLabel, stanceFor, statusTitle } from '../shared/pose.ts'
import { Hiker } from './Hiker.tsx'
import { useNow, useSession } from './hooks.ts'

export function SessionIndicator({ terminalId, onToggleComplete }: SessionIndicatorProps): React.JSX.Element | null {
  const host = usePluginHost()
  const session = useSession(host, terminalId)
  const now = useNow()
  const provider = session?.provider ?? 'claude'
  const look = useMemo(() => lookFor(terminalId, provider), [terminalId, provider])
  if (!session) return null
  const stance = stanceFor(session, choreFor(terminalId, now))
  const toggle = session.status === 'done' || session.status === 'complete' ? onToggleComplete : undefined
  return (
    <span
      className={`cs-indicator${toggle ? ' clickable' : ''}`}
      title={statusTitle(session.status, !!toggle)}
      onClick={
        toggle
          ? (e) => {
              e.stopPropagation()
              toggle()
            }
          : undefined
      }
    >
      <Hiker look={look} pose={stance.pose} gear={stance.gear} grey={stance.grey} sign={stance.sign} scale={1} label={hikerLabel(session)} decorative />
    </span>
  )
}
