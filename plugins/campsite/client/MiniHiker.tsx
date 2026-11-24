// A session's hiker at tab size, as a button: the collapsed campsite's row (and the strip's row when
// Pixi can't start). Hovered or keyboard-focused, a label above it names its crew member and tab
// (fixed to the window: the collapsed bar clips); a click opens its camper card.
import { useState } from 'react'
import { usePluginHost, type PluginSession } from '../../../src/shared/plugins/client.ts'
import { choreFor, hikerLabel, hikerTooltip, liveTool, stanceFor } from '../shared/pose.ts'
import { Hiker } from './Hiker.tsx'
import { useHikerLook, useTool } from './hooks.ts'

interface Props {
  session: PluginSession
  now: number
  /** The session's crew member ("Day hiker" with none), once the camp's state is loaded: its accessible name */
  crew?: string
  /** "Aspen · Claude 2" (campView's camperLabel) */
  label: string
  /** Its camper card is open */
  expanded: boolean
  onClick: (el: HTMLButtonElement) => void
}

export function MiniHiker({ session, now, crew, label, expanded, onClick }: Props): React.JSX.Element {
  const host = usePluginHost()
  const look = useHikerLook(host, session.terminalId, session.provider)
  const tool = liveTool(useTool(host, session.terminalId), now)
  const chore = choreFor(session.terminalId, now, tool)
  const stance = stanceFor(session, chore)
  // Where its label goes (window px: the button's top centre), while hovered or keyboard-focused
  const [tip, setTip] = useState<{ left: number; top: number } | null>(null)
  const show = (el: HTMLElement): void => {
    const r = el.getBoundingClientRect()
    setTip({ left: r.left + r.width / 2, top: r.top })
  }
  return (
    <button
      className="cs-mini"
      aria-label={hikerTooltip(session, chore, crew, tool)}
      aria-haspopup="dialog"
      aria-expanded={expanded}
      onPointerEnter={(e) => show(e.currentTarget)}
      onPointerLeave={() => setTip(null)}
      onFocus={(e) => {
        if (e.currentTarget.matches(':focus-visible')) show(e.currentTarget)
      }}
      onBlur={() => setTip(null)}
      onClick={(e) => {
        setTip(null)
        onClick(e.currentTarget)
      }}
    >
      <Hiker look={look} pose={stance.pose} gear={stance.gear} grey={stance.grey} scale={1} label={hikerLabel(session)} decorative />
      {tip && (
        <span className="cs-camper-label" style={{ left: tip.left, top: tip.top }}>
          {label}
        </span>
      )}
    </button>
  )
}
