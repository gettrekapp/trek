// The expanded strip's stage: a Pixi canvas (CampStage, loaded on first use so the app and the
// collapsed strip never pay for Pixi) under a DOM overlay of buttons over the hikers and the dog,
// which carry their names, tooltips, focus and clicks. If Pixi can't start (no WebGL), a note and a
// plain row of tab-size hikers instead.
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { PluginSession } from '../../../../src/shared/plugins/client.ts'
import type { CampSnapshot } from '../../shared/camp.ts'
import type { Edges } from '../../shared/campEdges.ts'
import { placedTitle } from '../../shared/campView.ts'
import type { BuildingId } from '../../shared/catalog.ts'
import { crewLabel } from '../../shared/crew.ts'
import type { CampLayout } from '../../shared/layout.ts'
import { choreFor, hikerLabel, hikerTooltip } from '../../shared/pose.ts'
import { STAGE_H } from '../../shared/stage.ts'
import { useReducedMotion } from '../hooks.ts'
import { MiniHiker } from '../MiniHiker.tsx'
import type { CampStage, SignColors } from './CampStage.ts'

interface Props {
  layout: CampLayout
  /** The buildings at the strip's ends (campEdges.ts) */
  edges: Edges
  /** Each building's tier; the same object while the tiers are the same (a wood-only push doesn't redraw) */
  built: Readonly<Record<BuildingId, number>>
  sessions: readonly PluginSession[]
  /** The camp's snapshot (its crew names the hikers' tooltips); null until it loads */
  camp: CampSnapshot | null
  /** The chores' clock */
  now: number
  selected: string | null
  /** The window is hidden */
  paused: boolean
  showDog: boolean
  onPick: (terminalId: string) => void
  /** A building's button was clicked: open the camp at its row */
  onBuilding: (id: BuildingId, el: HTMLButtonElement) => void
}

type Load = { state: 'loading' } | { state: 'ready'; stage: CampStage } | { state: 'failed' }

/**
 * A theme's color token, if it is a #rrggbb Pixi can read; else the fallback. The sign colors are
 * read once, when the stage mounts: a theme switch shows the next time the strip opens, and only
 * #rrggbb values are taken (a theme's rgb(), hsl() or named color falls back).
 */
function token(style: CSSStyleDeclaration, name: string, fallback: string): string {
  const value = style.getPropertyValue(name).trim()
  return /^#[0-9a-f]{6}$/i.test(value) ? value : fallback
}

export function PixiStrip({ layout, edges, built, sessions, camp, now, selected, paused, showDog, onPick, onBuilding }: Props): React.JSX.Element {
  const reduced = useReducedMotion()
  const host = useRef<HTMLDivElement>(null)
  const [load, setLoad] = useState<Load>({ state: 'loading' })

  useEffect(() => {
    const el = host.current
    if (!el) return
    let gone = false
    let made: CampStage | null = null
    const style = getComputedStyle(el)
    const colors: SignColors = { attention: token(style, '--attention', '#e2a336'), decision: token(style, '--decision', '#b18cff') }
    import('./CampStage.ts')
      .then(({ CampStage }) => CampStage.create(el, colors))
      .then((stage) => {
        if (gone) stage.destroy()
        else {
          made = stage
          setLoad({ state: 'ready', stage })
        }
      })
      .catch((err: unknown) => {
        console.warn('[campsite] the strip could not start Pixi', err)
        if (!gone) setLoad({ state: 'failed' })
      })
    return () => {
      gone = true
      made?.destroy()
    }
  }, [])

  const stage = load.state === 'ready' ? load.stage : null
  // Before paint, so a new hiker's overlay button is placed over its sprite in the same frame
  useLayoutEffect(() => {
    stage?.update({ layout, sessions, now, selected, reduced, paused, showDog, edges, built })
  }, [stage, layout, sessions, now, selected, reduced, paused, showDog, edges, built])

  if (load.state === 'failed') {
    return (
      <div className="cs-fallback">
        <span className="cs-fallback-note">The campsite couldn't start its renderer.</span>
        <div className="cs-mini-row">
          {sessions.map((s) => (
            <MiniHiker key={s.terminalId} session={s} now={now} crew={camp ? crewLabel(camp, s.terminalId) : undefined} onClick={() => onPick(s.terminalId)} />
          ))}
        </div>
      </div>
    )
  }
  const byId = new Map(sessions.map((s) => [s.terminalId, s]))
  return (
    <>
      <div ref={host} className="cs-canvas" aria-hidden="true" />
      {/* Over each building's sprite (they don't move), under the dog's and hikers' buttons */}
      {stage &&
        [...edges.left, ...edges.right].map((p) => (
          <button
            key={p.key}
            className="cs-building"
            style={{ left: p.x, width: p.w, height: p.h, bottom: STAGE_H - p.bottom }}
            title={placedTitle(p)}
            aria-label={placedTitle(p)}
            onClick={(e) => onBuilding(p.id, e.currentTarget)}
          />
        ))}
      {stage && showDog && <button ref={(el) => stage.bindDog(el)} className="cs-dog" title="Pet the dog" aria-label="Pet the dog" onClick={() => stage.petDog()} />}
      {stage &&
        layout.hikers.map((h) => {
          const s = byId.get(h.terminalId)
          if (!s) return null
          return (
            <button
              key={h.terminalId}
              ref={(el) => stage.bindTarget(h.terminalId, el)}
              className={`cs-camp-hiker${h.place === 'inside' ? ' inside' : ''}`}
              title={hikerTooltip(s, choreFor(s.terminalId, now), camp ? crewLabel(camp, s.terminalId) : undefined)}
              aria-label={hikerLabel(s)}
              onClick={() => onPick(s.terminalId)}
            />
          )
        })}
    </>
  )
}
