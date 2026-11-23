// The hiker on its terminal's quick button row (2×), with what its session is doing. On the row,
// not over the terminal, so it never covers output. A waiting session shows its tab's chip here
// too: a sign board over the head would rise into the terminal's last line.
import { usePluginHost } from '../../../src/shared/plugins/client.ts'
import { DEFAULT_AGENT_ID } from '../../../src/shared/plugins/agents.ts'
import { crewLabel } from '../shared/crew.ts'
import { SIGN_TEXT, choreFor, hikerDoing, hikerLabel, hikerTooltip, liveTool, stanceFor } from '../shared/pose.ts'
import { Hiker } from './Hiker.tsx'
import { useCamp, useHikerLook, useNow, usePrefs, useSession, useTool } from './hooks.ts'

export function TerminalHiker({ terminalId }: { terminalId: string }): React.JSX.Element | null {
  const host = usePluginHost()
  const [{ loaded, prefs }] = usePrefs(host)
  const session = useSession(host, terminalId)
  const camp = useCamp(host)
  const now = useNow()
  const provider = session?.provider ?? DEFAULT_AGENT_ID
  const look = useHikerLook(host, terminalId, provider)
  // The call its words name: none once it is stale (its chore is a random one again)
  const tool = liveTool(useTool(host, terminalId), now)
  if (!loaded || !prefs.showTerminalHiker || !session) return null
  const chore = choreFor(terminalId, now, tool)
  const stance = stanceFor(session, chore)
  return (
    <span className="cs-bar-hiker" title={hikerTooltip(session, chore, camp ? crewLabel(camp, terminalId) : undefined, tool)}>
      <span className={`cs-bar-text${stance.sign ? ` ${stance.sign}` : ''}`}>
        {session.label} · {hikerDoing(session, chore, tool)}
      </span>
      {stance.sign && (
        <span className={`cs-tab-sign ${stance.sign}`} aria-hidden="true">
          {SIGN_TEXT[stance.sign]}
        </span>
      )}
      <Hiker look={look} pose={stance.pose} gear={stance.gear} grey={stance.grey} scale={2} label={hikerLabel(session)} decorative />
    </span>
  )
}
