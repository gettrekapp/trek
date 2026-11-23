// The expanded strip's stage: a Pixi canvas (CampStage, loaded on first use so the app and the
// collapsed strip never pay for Pixi) under a DOM overlay of buttons over the buildings, the
// mountain's flags (and a ledge's "+n"), the cairn, the hikers and the dog, which carry their names,
// tooltips, focus and clicks; the signpost's planks say how many trails there are. If Pixi can't
// start (no WebGL), a note and a plain row of tab-size hikers instead.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { PluginSession } from '../../../../src/shared/plugins/client.ts'
import { BUILDING_SCALE, SIGNPOST_PLANK } from '../../shared/buildingPixels.ts'
import type { CampSnapshot } from '../../shared/camp.ts'
import type { Edges } from '../../shared/campEdges.ts'
import { cairnText, flagLabel, placedTitle, signpostText } from '../../shared/campView.ts'
import type { BuildingId } from '../../shared/catalog.ts'
import { crewLabel } from '../../shared/crew.ts'
import type { CampLayout } from '../../shared/layout.ts'
import { cairnBox, flagBox, flagSpots, mountain, type FlagTrail } from '../../shared/mountain.ts'
import { choreFor, hikerLabel, hikerTooltip } from '../../shared/pose.ts'
import { STAGE_H } from '../../shared/stage.ts'
import { STAGES, cairnSize } from '../../shared/trails.ts'
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
  /** terminalId → its member's kitKey (the same object while no one's gear changes) */
  kits: Readonly<Record<string, string>>
  /** The window's project's trails (the same array while none of its flags change) */
  trails: readonly FlagTrail[]
  /** The camp's summits (the cairn) */
  summits: number
  /** The last summit to celebrate here */
  summit: { worktreeId: string; seq: number } | null
  /** The chores' clock */
  now: number
  selected: string | null
  /** The window is hidden */
  paused: boolean
  showDog: boolean
  onPick: (terminalId: string) => void
  /** A building's button was clicked: open the camp at its row */
  onBuilding: (id: BuildingId, el: HTMLButtonElement) => void
  /** A flag (its worktree), a ledge's "+n" or the cairn was clicked: open the Trails tab (at that trail) */
  onTrail: (el: HTMLButtonElement, worktreeId?: string) => void
}

/** A flag's button reaches this far above and below its sprite; across, it is its sprite and the 1 px gap after it (neighbours side by side, never overlapping) */
const FLAG_PAD = 3

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

export function PixiStrip({ layout, edges, built, sessions, camp, kits, trails, summits, summit, now, selected, paused, showDog, onPick, onBuilding, onTrail }: Props): React.JSX.Element {
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
    stage?.update({ layout, sessions, now, selected, reduced, paused, showDog, edges, built, kits, trails, summits, summit })
  }, [stage, layout, sessions, now, selected, reduced, paused, showDog, edges, built, kits, trails, summits, summit])

  // The flags' buttons, where the stage draws them (before the fallback's early return: a hook)
  const room = layout.width - edges.reserve.left - edges.reserve.right
  const m = useMemo(() => mountain(layout.fireX, room), [layout.fireX, room])
  const spots = useMemo(() => flagSpots(m, trails), [m, trails])
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
  const allTrails = camp?.trails?.length ?? 0
  // On the trailhead's shelf (the mountain's cairn spot)
  const cairn = cairnSize(summits) > 0 ? cairnBox(m) : null
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
            title={p.id === 'signpost' ? `${placedTitle(p)}: ${signpostText(allTrails)}` : placedTitle(p)}
            aria-label={p.id === 'signpost' ? `${placedTitle(p)}: ${signpostText(allTrails)}` : placedTitle(p)}
            onClick={(e) => onBuilding(p.id, e.currentTarget)}
          >
            {p.id === 'signpost' && (
              <span
                className="cs-signpost-text"
                aria-hidden="true"
                style={{ left: SIGNPOST_PLANK.x * BUILDING_SCALE, top: SIGNPOST_PLANK.y * BUILDING_SCALE, width: SIGNPOST_PLANK.w * BUILDING_SCALE, height: SIGNPOST_PLANK.h * BUILDING_SCALE }}
              >
                {signpostText(allTrails)}
              </span>
            )}
          </button>
        ))}
      {/* Over the mountain's flags (they move only while one climbs), the ledges' "+n" and the cairn */}
      {stage &&
        spots.flags.map((f) => {
          const box = flagBox(f)
          return (
            <button
              key={f.worktreeId}
              className="cs-flag"
              style={{ left: box.x, bottom: STAGE_H - box.y - box.h - FLAG_PAD, width: box.w + 1, height: box.h + 2 * FLAG_PAD }}
              title={flagLabel(f)}
              aria-label={flagLabel(f)}
              onClick={(e) => onTrail(e.currentTarget, f.worktreeId)}
            />
          )
        })}
      {stage &&
        spots.more.map((m) => (
          <button key={m.stage} className="cs-flag-more" style={{ left: m.x, bottom: STAGE_H - m.y }} title={`${m.count} more at ${STAGES[m.stage]}`} aria-label={`${m.count} more trails at ${STAGES[m.stage]}`} onClick={(e) => onTrail(e.currentTarget)}>
            +{m.count}
          </button>
        ))}
      {stage && cairn && (
        <button className="cs-cairn" style={{ left: cairn.x, bottom: STAGE_H - cairn.y - cairn.h, width: cairn.w, height: cairn.h }} title={cairnText(summits)} aria-label={cairnText(summits)} onClick={(e) => onTrail(e.currentTarget)} />
      )}
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
