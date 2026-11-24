// A camper's card (a hiker on the strip or in the collapsed bar, clicked): its crew member (portrait
// wearing its gear, level, XP, the gear's bonus, its pin) or "Day hiker", this trip (the tab, the
// place, what it's up to), Go to terminal (focused on opening) and, for a member, Open in camp (the
// camp popover at its view). Fixed to the window above the camper, kept inside it. Campsite closes
// it: Escape (the focus back to the camper), a press outside, a resize, the strip collapsing or
// expanding, the session or the camp's state going, or another popover opening.
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { usePluginHost, type PluginSession } from '../../../src/shared/plugins/client.ts'
import type { CamperCardModel } from '../shared/campView.ts'
import { Hiker } from './Hiker.tsx'
import { useHikerLook } from './hooks.ts'

/** Where a camper's card opens: its hiker's button's left, right and top (window px), when clicked */
export interface OpenCamper {
  terminalId: string
  left: number
  right: number
  top: number
}

const EDGE = 8

interface Props {
  at: OpenCamper
  session: PluginSession
  card: CamperCardModel
  onGo: () => void
  onOpenCamp: (crewId: string) => void
}

export function CamperCard({ at, session, card, onGo, onOpenCamp }: Props): React.JSX.Element {
  const host = usePluginHost()
  const look = useHikerLook(host, session.terminalId, session.provider)
  const ref = useRef<HTMLDivElement>(null)
  const go = useRef<HTMLButtonElement>(null)
  const centre = (at.left + at.right) / 2
  const [left, setLeft] = useState(centre)
  // Centred over the camper, inside the window, once its width is known (before paint)
  useLayoutEffect(() => {
    const el = ref.current
    if (el) setLeft(Math.max(EDGE, Math.min(centre - el.offsetWidth / 2, window.innerWidth - el.offsetWidth - EDGE)))
  })
  useEffect(() => {
    go.current?.focus()
  }, [])
  const m = card.member
  const name = m?.name ?? 'Day hiker'
  return (
    <div ref={ref} className="cs-camper-card" role="dialog" aria-label={`${name}, ${card.tab}`} style={{ left, top: at.top - 4 }}>
      <div className="cs-camper-head">
        <Hiker look={look} pose="stand" scale={2} label={name} decorative />
        <div className="cs-crew-text">
          <span className="cs-crew-name">
            {name} {m && <span className="cs-crew-level">{m.level}</span>}
          </span>
          {m ? (
            <span
              className="cs-xp"
              title={m.xp}
              role="progressbar"
              aria-label={`${m.name}'s XP`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={m.progress}
              aria-valuetext={m.xp}
            >
              <span style={{ width: `${m.progress}%` }} />
            </span>
          ) : (
            <span className="cs-camper-none">No crew member</span>
          )}
          {m?.bonus && <span className="cs-member-bonus">{m.bonus}</span>}
          {m?.pin && <span className="cs-camper-pin">{m.pin}</span>}
        </div>
      </div>
      <dl className="cs-camper-trip">
        <dt>Tab</dt>
        <dd title={card.tab}>{card.tab}</dd>
        <dt>Where</dt>
        <dd title={card.place}>{card.place || '—'}</dd>
        <dt>Doing</dt>
        <dd title={card.doing}>{card.doing}</dd>
      </dl>
      <div className="cs-camper-actions">
        {m && (
          <button className="cs-camper-camp" onClick={() => onOpenCamp(m.id)}>
            Open in camp
          </button>
        )}
        <button ref={go} className="cs-shop-build" onClick={onGo}>
          Go to terminal
        </button>
      </div>
    </div>
  )
}
