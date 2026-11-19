// A hiker at the campsite strip (2.5×): a new session's walks in from the nearer edge, walks to each new spot, and
// walks off when its session closes (Campsite's departures). A button: click to show its session.
import { useEffect, useMemo, useRef, useState } from 'react'
import type { PluginSession } from '../../../src/shared/plugins/client.ts'
import { lookFor } from '../shared/hiker.ts'
import type { Place } from '../shared/layout.ts'
import { hikerLabel, hikerTooltip, stanceFor, type Chore, type Stance } from '../shared/pose.ts'
import { Hiker } from './Hiker.tsx'
import { useReducedMotion } from './hooks.ts'

const SCALE = 2.5
const HALF = 6 * SCALE
/** Matches .cs-camp-hiker's transform transition */
export const WALK_MS = 1200

const WALK: Stance = { pose: 'walk', grey: false, sign: null }

/** Off the strip, past the edge nearer `x` */
export const offstage = (x: number, width: number): number => (x < width / 2 ? -HALF * 3 : width + HALF * 3)

interface Props {
  session: PluginSession
  x: number
  place: Place
  width: number
  chore: Chore
  selected: boolean
  /** Where it appears before walking to `x`: a leaving hiker's last spot, or `x` for one already at camp; default: the nearer edge */
  startX?: number
  leaving?: boolean
  onClick?: () => void
}

export function CampHiker({ session, x, place, width, chore, selected, startX, leaving = false, onClick }: Props): React.JSX.Element {
  const look = useMemo(() => lookFor(session.terminalId, session.provider), [session.terminalId, session.provider])
  const reduced = useReducedMotion()
  const [initialX] = useState(() => startX ?? offstage(x, width))
  const shown = useRef(initialX)
  const [shownX, setShownX] = useState(initialX)
  // Reduced motion: no walk pose (the move itself is instant, campsite.css)
  const [walking, setWalking] = useState(() => !reduced && initialX !== x)
  const [facingLeft, setFacingLeft] = useState(x < initialX)
  // Any move is a walk, set two frames on so the start position has been painted and the transition runs from it
  useEffect(() => {
    let raf = requestAnimationFrame(() => {
      raf = requestAnimationFrame(() => {
        const from = shown.current
        if (from === x) return
        shown.current = x
        setFacingLeft(x < from)
        if (!reduced) setWalking(true)
        setShownX(x)
      })
    })
    return () => cancelAnimationFrame(raf)
  }, [x, reduced])
  useEffect(() => {
    if (!walking) return
    const timer = setTimeout(() => setWalking(false), WALK_MS)
    return () => clearTimeout(timer)
  }, [walking, shownX])
  const stance = walking || (leaving && !reduced) ? WALK : stanceFor(session, chore)
  const inside = place === 'inside'
  return (
    <button
      className={`cs-camp-hiker${selected ? ' selected' : ''}${inside ? ' inside' : ''}${facingLeft ? ' left' : ''}`}
      style={{ transform: `translateX(${shownX - HALF}px)` }}
      title={hikerTooltip(session, chore)}
      onClick={onClick}
      tabIndex={leaving ? -1 : 0}
      aria-hidden={leaving || undefined}
    >
      <span className="cs-facing">
        <Hiker look={look} pose={stance.pose} gear={stance.gear} grey={stance.grey || inside} sign={stance.sign} scale={SCALE} label={hikerLabel(session)} />
      </span>
    </button>
  )
}
