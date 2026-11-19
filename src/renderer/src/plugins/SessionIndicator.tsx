// A session tab's status: the first active plugin's sessionIndicator (campsite's hiker), else the
// core badge. A plugin indicator that throws shows the badge, so a tab never loses its status.
import type { TerminalStatus } from '../../../shared/types'
import { StatusBadge } from '../components/StatusBadge'
import { PluginScope, usePluginEntries } from './PluginHost'
import { firstActiveSlot } from './slots.ts'

interface Props {
  terminalId: string
  status: TerminalStatus | null
  onToggleComplete?: () => void
}

export function SessionIndicator({ terminalId, status, onToggleComplete }: Props): React.JSX.Element | null {
  const entry = firstActiveSlot(usePluginEntries(), 'sessionIndicator')
  const badge = <StatusBadge status={status} onToggleComplete={onToggleComplete} />
  if (!entry) return badge
  const Slot = entry.plugin.slots!.sessionIndicator!
  return (
    <PluginScope key={entry.key} entry={entry} fallback={badge}>
      <Slot terminalId={terminalId} status={status} onToggleComplete={onToggleComplete} />
    </PluginScope>
  )
}
