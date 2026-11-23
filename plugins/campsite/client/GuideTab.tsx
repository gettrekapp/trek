// The camp popover's Guide tab (campsite part 3d-2): the field guide. A grid of the 20 common species
// then, under "Rare", the 4 rares: each card its still sprite, name, how often it was seen and when
// first; an unseen one a dark silhouette and "???", with a hint built from its gates at ranger tower
// II, and a rare "Needs the ranger tower" without the tower. A dot marks a species first seen since
// the tab was last opened (the prefs' guideSeenAt, as it was when the tab opened; opening it marks
// the guide seen now). The cards are one tab stop: the arrow keys (and Home and End) move between
// them. Opened at a species (an animal on the strip was clicked), its card takes the focus (the
// selected tab when this version can't show it). The words are campView's.
import { useEffect, useRef, useState } from 'react'
import { animalPixels, animalSize } from '../shared/animalPixels.ts'
import type { CampSnapshot } from '../shared/camp.ts'
import { guideCards, type GuideCard } from '../shared/campView.ts'

interface Props {
  camp: CampSnapshot
  /** A species to show (its card focused), else null */
  focus: string | null
  /** When the tab was last opened (ms) */
  since: number
  /** The tab is open: the guide is seen now */
  onSeen: () => void
}

/** Cards in a row of the grid (.cs-guide-grid's columns) */
const COLUMNS = 4
/** An unseen species' silhouette */
const SHADOW = '#45414d'

export function GuideTab({ camp, focus, since, onSeen }: Props): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  // The new dots stay for this visit: what was new when the tab opened
  const [newSince] = useState(since)
  const { commons, rares } = guideCards(camp, newSince)
  const cards = [...commons, ...rares]
  const [current, setCurrent] = useState<string>(() => (focus !== null && cards.some((c) => c.id === focus) ? focus : cards[0].id))
  useEffect(() => {
    onSeen()
  }, [])
  useEffect(() => {
    if (focus === null) return
    const card = ref.current?.querySelector<HTMLElement>(`[data-species="${CSS.escape(focus)}"]`)
    if (!card) {
      ref.current?.closest('.cs-camp-popover')?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus()
      return
    }
    card.scrollIntoView({ block: 'nearest' })
    card.focus()
  }, [])
  /** The arrows step through the cards (Up and Down by a row), Home and End to the ends; focus follows */
  const onKey = (e: React.KeyboardEvent): void => {
    const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -COLUMNS, ArrowDown: COLUMNS }[e.key]
    const at = cards.findIndex((c) => c.id === current)
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? cards.length - 1 : step === undefined ? -1 : Math.min(cards.length - 1, Math.max(0, at + step))
    if (next < 0) return
    e.preventDefault()
    setCurrent(cards[next].id)
    ref.current?.querySelector<HTMLElement>(`[data-species="${CSS.escape(cards[next].id)}"]`)?.focus()
  }
  const grid = (list: GuideCard[]): React.JSX.Element => (
    <div className="cs-guide-grid">
      {list.map((c) => (
        <Card key={c.id} card={c} tabbable={c.id === current} onFocus={() => setCurrent(c.id)} />
      ))}
    </div>
  )
  return (
    <div ref={ref} className="cs-guide" onKeyDown={onKey}>
      {grid(commons)}
      <div className="cs-crew-heading">Rare</div>
      {grid(rares)}
    </div>
  )
}

function Card({ card, tabbable, onFocus }: { card: GuideCard; tabbable: boolean; onFocus: () => void }): React.JSX.Element {
  return (
    <div className={`cs-guide-card${card.seen ? '' : ' unseen'}`} data-species={card.id} tabIndex={tabbable ? 0 : -1} role="group" aria-label={card.label} title={card.label} onFocus={onFocus}>
      {card.isNew && <span className="cs-guide-new" aria-hidden="true" />}
      <AnimalIcon id={card.id} shadow={!card.seen} />
      <span className="cs-guide-name" aria-hidden="true">
        {card.name}
      </span>
      {card.count && (
        <span className="cs-guide-count" aria-hidden="true">
          {card.count}
        </span>
      )}
      {card.line && (
        <span className="cs-guide-line" aria-hidden="true">
          {card.line}
        </span>
      )}
    </div>
  )
}

/** A species' first frame, scaled whole into 48×36; unseen, its silhouette */
function AnimalIcon({ id, shadow }: { id: string; shadow: boolean }): React.JSX.Element {
  const { w, h } = animalSize(id)
  const scale = Math.max(1, Math.floor(Math.min(48 / w, 36 / h)))
  return (
    <span className="cs-guide-icon" aria-hidden="true">
      <svg width={w * scale} height={h * scale} viewBox={`0 0 ${w} ${h}`} shapeRendering="crispEdges">
        {animalPixels(id, 0).map((r, i) => (
          <rect key={i} x={r.x} y={r.y} width={r.w} height={r.h} fill={shadow ? SHADOW : r.fill} />
        ))}
      </svg>
    </span>
  )
}
