// A session's hiker at tab size, as a button: the collapsed campsite's row. Click to show its session.
import { useMemo } from 'react'
import type { PluginSession } from '../../../src/shared/plugins/client.ts'
import { lookFor } from '../shared/hiker.ts'
import { choreFor, hikerLabel, hikerTooltip, stanceFor } from '../shared/pose.ts'
import { Hiker } from './Hiker.tsx'

/** `crew`: the session's crew member ("Day hiker" with none), once the camp's state is loaded */
export function MiniHiker({ session, now, crew, onClick }: { session: PluginSession; now: number; crew?: string; onClick: () => void }): React.JSX.Element {
  const look = useMemo(() => lookFor(session.terminalId, session.provider), [session.terminalId, session.provider])
  const chore = choreFor(session.terminalId, now)
  const stance = stanceFor(session, chore)
  return (
    <button className="cs-mini" title={hikerTooltip(session, chore, crew)} aria-label={hikerLabel(session)} onClick={onClick}>
      <Hiker look={look} pose={stance.pose} gear={stance.gear} grey={stance.grey} scale={1} label={hikerLabel(session)} decorative />
    </button>
  )
}
