// A session's hiker at tab size, as a button: the collapsed campsite's row. Click to show its session.
import { usePluginHost, type PluginSession } from '../../../src/shared/plugins/client.ts'
import { choreFor, hikerLabel, hikerTooltip, liveTool, stanceFor } from '../shared/pose.ts'
import { Hiker } from './Hiker.tsx'
import { useHikerLook, useTool } from './hooks.ts'

/** `crew`: the session's crew member ("Day hiker" with none), once the camp's state is loaded */
export function MiniHiker({ session, now, crew, onClick }: { session: PluginSession; now: number; crew?: string; onClick: () => void }): React.JSX.Element {
  const host = usePluginHost()
  const look = useHikerLook(host, session.terminalId, session.provider)
  const tool = liveTool(useTool(host, session.terminalId), now)
  const chore = choreFor(session.terminalId, now, tool)
  const stance = stanceFor(session, chore)
  return (
    <button className="cs-mini" title={hikerTooltip(session, chore, crew, tool)} aria-label={hikerLabel(session)} onClick={onClick}>
      <Hiker look={look} pose={stance.pose} gear={stance.gear} grey={stance.grey} scale={1} label={hikerLabel(session)} decorative />
    </button>
  )
}
