// A worktree's tent at the campsite strip, with its branch on a sign. Grouped (a crowded camp), it
// carries a count badge that opens a list of its sessions.
import type { PluginSession } from '../../../src/shared/plugins/client.ts'
import { signText, tentBadge, type CampTent } from '../shared/layout.ts'
import { hikerLabel } from '../shared/pose.ts'

interface Props {
  tent: CampTent
  grouped: boolean
  open: boolean
  members: readonly PluginSession[]
  onToggle: () => void
  onPick: (terminalId: string) => void
}

export function Tent({ tent, grouped, open, members, onToggle, onPick }: Props): React.JSX.Element {
  return (
    <div className="cs-tent" style={{ left: tent.x - 42 }}>
      <svg width={84} height={52} viewBox="0 0 84 52" aria-hidden="true">
        <polygon points="4,52 42,8 80,52" fill="#c08a2e" />
        <polygon points="34,52 42,24 50,52" fill="#3a2a16" />
        <rect x={60} y={30} width={2} height={22} fill="#5a3a22" />
      </svg>
      <span className="cs-tent-sign" title={tent.name}>
        {signText(tent.name)}
      </span>
      {grouped && (
        <button className={`cs-tent-badge${tent.waiting ? ' waiting' : ''}`} onClick={onToggle} aria-expanded={open} title="Who's in this camp">
          {tentBadge(tent)}
        </button>
      )}
      {grouped && open && (
        <div className="cs-tent-popover" role="menu">
          {members.map((s) => (
            <button key={s.terminalId} role="menuitem" onClick={() => onPick(s.terminalId)}>
              {hikerLabel(s)}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
