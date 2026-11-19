// A worktree's tent at the campsite strip, with its branch on a sign. Grouped (a crowded camp), it
// carries a count badge that opens a list of its sessions (TentPopover, drawn beside the tents so it
// sits over the app, not inside the tent's stacking context).
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { PluginSession } from '../../../src/shared/plugins/client.ts'
import { popoverLeft, signText, tentBadge, type CampTent } from '../shared/layout.ts'
import { hikerLabel } from '../shared/pose.ts'

interface Props {
  tent: CampTent
  grouped: boolean
  open: boolean
  /** The badge was clicked */
  onToggle: (badge: HTMLButtonElement) => void
}

export function Tent({ tent, grouped, open, onToggle }: Props): React.JSX.Element {
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
        <button
          className={`cs-tent-badge${tent.waiting ? ' waiting' : ''}`}
          onClick={(e) => onToggle(e.currentTarget)}
          aria-haspopup="true"
          aria-expanded={open}
          title="Who's in this camp"
        >
          {tentBadge(tent)}
        </button>
      )}
    </div>
  )
}

/** The open tent: its worktree and where its badge is (window coordinates) */
export interface OpenTent {
  worktreeId: string
  /** The badge's left */
  left: number
  /** The badge's top; the popover sits just above */
  top: number
}

interface PopoverProps {
  at: OpenTent
  name: string
  members: readonly PluginSession[]
  onPick: (terminalId: string) => void
}

export function TentPopover({ at, name, members, onPick }: PopoverProps): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [left, setLeft] = useState(at.left)
  // Kept inside the window, once its width is known (before paint)
  useLayoutEffect(() => {
    const el = ref.current
    if (el) setLeft(popoverLeft(at.left, el.offsetWidth, window.innerWidth))
  }, [at.left, members.length])
  // Keyboard users land in the list
  useEffect(() => {
    ref.current?.querySelector('button')?.focus()
  }, [])
  return (
    <div ref={ref} className="cs-tent-popover" role="group" aria-label={`Sessions at ${name}`} style={{ left, top: at.top - 4 }}>
      {members.map((s) => (
        <button key={s.terminalId} onClick={() => onPick(s.terminalId)}>
          {hikerLabel(s)}
        </button>
      ))}
    </div>
  )
}
