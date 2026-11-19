// The hiker in its terminal's corner (3×). The core's wrapper dims it while the user types or
// scrolls back; it takes no clicks.
import { useMemo } from 'react'
import { usePluginHost } from '../../../src/shared/plugins/client.ts'
import { lookFor } from '../shared/hiker.ts'
import { choreFor, hikerLabel, stanceFor } from '../shared/pose.ts'
import { Hiker } from './Hiker.tsx'
import { useNow, usePrefs, useSession } from './hooks.ts'

export function TerminalHiker({ terminalId }: { terminalId: string }): React.JSX.Element | null {
  const host = usePluginHost()
  const [{ loaded, prefs }] = usePrefs(host)
  const session = useSession(host, terminalId)
  const now = useNow()
  const provider = session?.provider ?? 'claude'
  const look = useMemo(() => lookFor(terminalId, provider), [terminalId, provider])
  if (!loaded || !prefs.showTerminalHiker || !session) return null
  const stance = stanceFor(session, choreFor(terminalId, now))
  return (
    <div className="cs-terminal-hiker">
      <Hiker look={look} pose={stance.pose} gear={stance.gear} grey={stance.grey} sign={stance.sign} scale={3} label={hikerLabel(session)} />
    </div>
  )
}
