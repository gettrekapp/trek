// The expanded strip's stage: a Pixi canvas (CampStage, loaded on first use so the app and the
// collapsed strip never pay for Pixi) under a DOM overlay of buttons over the buildings, the
// mountain's flags (and a ledge's "+n"), the cairn, the hikers, the dog and a sighting's animal (part 3d-2), which carry their names,
// tooltips (a hiker's: its crew name and tab, in CSS), focus and clicks (a hiker's opens its camper card); the signpost's planks say how many trails there are; the noticeboard
// (part 5) has a button too. If Pixi can't start (no WebGL), a note and a plain row of tab-size hikers instead.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { PluginSession } from '../../../../src/shared/plugins/client.ts'
import { BUILDING_SCALE, SIGNPOST_PLANK } from '../../shared/buildingPixels.ts'
import type { CampSnapshot } from '../../shared/camp.ts'
import type { Edges } from '../../shared/campEdges.ts'
import { animalLabel, cairnText, camperLabel, flagLabel, placedTitle, signpostText } from '../../shared/campView.ts'
import type { BuildingId } from '../../shared/catalog.ts'
import { crewLabel } from '../../shared/crew.ts'
import type { Crossing } from '../../shared/crossing.ts'
import type { CampLayout } from '../../shared/layout.ts'
import { cairnBox, flagSpots, flagTargets, moreBox, mountain, type FlagTrail } from '../../shared/mountain.ts'
import { choreFor, hikerTooltip, liveTool, type HikerTool } from '../../shared/pose.ts'
import { STAGE_H } from '../../shared/stage.ts'
import { STAGES, cairnSize } from '../../shared/trails.ts'
import { worldPalette, type World } from '../../shared/world.ts'
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
  /** Each session's latest tool call (part 4), by terminalId: the same object while none changes */
  tools: Readonly<Record<string, HikerTool>>
  /** The time of day, the season and the weather (part 3d-1); the same object while they look the same */
  world: World
  selected: string | null
  /** The window is hidden */
  paused: boolean
  showDog: boolean
  /** A camper (its hiker's button) was clicked: open its card, or close it if it's that camper's */
  onCamper: (terminalId: string, el: HTMLButtonElement) => void
  /** The camper whose card is open (its button's aria-expanded), else null */
  openCamper: string | null
  /** A building's button was clicked: open the camp at its row */
  onBuilding: (id: BuildingId, el: HTMLButtonElement) => void
  /** A flag (its worktree), a ledge's "+n" or the cairn was clicked: open the Trails tab (at that trail); `opener` names which ("flag:<worktree>", "more:<stage>", "cairn") */
  onTrail: (el: HTMLButtonElement, opener: string, worktreeId?: string) => void
  /** The opener whose Trails tab is open (aria-expanded), else null */
  openTrail: string | null
  /** The sighting's animal crossing now (Campsite's; its seq changes for each one), else null */
  animal: { seq: number; crossing: Crossing } | null
  /** The animal's button was clicked: open the field guide at its species */
  onAnimal: (species: string, el: HTMLButtonElement) => void
  /** The popover was opened by the animal (its button's aria-expanded) */
  animalOpen: boolean
  /** The animal's button went (its crossing ended) while it had the focus: the focus goes elsewhere (the counts) */
  onAnimalGone: () => void
  /** The noticeboard (part 5): where it stands, whether a note is unread, its button's name; null: none (the same object while none of that changes) */
  board: { x: number; w: number; h: number; bottom: number; unread: boolean; label: string } | null
  /** The noticeboard's button was clicked: open the Noticeboard */
  onBoard: (el: HTMLButtonElement) => void
  /** The popover was opened by the noticeboard (its button's aria-expanded) */
  boardOpen: boolean
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

export function PixiStrip({ layout, edges, built, sessions, camp, kits, trails, summits, summit, now, tools, world, selected, paused, showDog, onCamper, openCamper, onBuilding, onTrail, openTrail, animal, onAnimal, animalOpen, onAnimalGone, board, onBoard, boardOpen }: Props): React.JSX.Element {
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
  // The backdrop's colours: worked out again only when the world looks different
  const palette = useMemo(() => worldPalette(world), [world])
  // What the stage draws of the noticeboard: the same object while it stands in the same place, read or unread
  const boardX = board?.x
  const boardBottom = board?.bottom
  const boardUnread = board?.unread
  const stageBoard = useMemo(() => (boardX === undefined || boardBottom === undefined ? null : { x: boardX, bottom: boardBottom, unread: boardUnread === true }), [boardX, boardBottom, boardUnread])
  // Before paint, so a new hiker's overlay button is placed over its sprite in the same frame
  useLayoutEffect(() => {
    stage?.update({ layout, sessions, now, tools, selected, reduced, paused, showDog, edges, built, kits, trails, summits, summit, world, palette, animal, board: stageBoard })
  }, [stage, layout, sessions, now, tools, selected, reduced, paused, showDog, edges, built, kits, trails, summits, summit, world, palette, animal, stageBoard])

  // The flags' buttons, where the stage draws them (before the fallback's early return: a hook)
  const room = layout.width - edges.reserve.left - edges.reserve.right
  const m = useMemo(() => mountain(layout.fireX, room), [layout.fireX, room])
  const spots = useMemo(() => flagSpots(m, trails), [m, trails])
  // Each flag's button: its sprite and the gap after it, a few px taller where nothing else is (never overlapping)
  const targets = useMemo(() => flagTargets(m, spots), [m, spots])
  if (load.state === 'failed') {
    return (
      <div className="cs-fallback">
        <span className="cs-fallback-note">The campsite couldn't start its renderer.</span>
        <div className="cs-mini-row">
          {sessions.map((s) => (
            <MiniHiker
              key={s.terminalId}
              session={s}
              now={now}
              crew={camp ? crewLabel(camp, s.terminalId) : undefined}
              label={camperLabel(camp, s)}
              expanded={openCamper === s.terminalId}
              onClick={(el) => onCamper(s.terminalId, el)}
            />
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
            data-building={p.id}
            style={{ left: p.x, width: p.w, height: p.h, bottom: STAGE_H - p.bottom }}
            title={p.id === 'signpost' ? `${placedTitle(p)}: ${signpostText(allTrails)}` : placedTitle(p)}
            aria-label={p.id === 'signpost' ? `${placedTitle(p)}: ${signpostText(allTrails)}` : placedTitle(p)}
            aria-haspopup={p.id === 'signpost' ? 'dialog' : undefined}
            aria-expanded={p.id === 'signpost' ? openTrail === 'signpost' : undefined}
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
      {/* Over the noticeboard's sprite (part 5): it opens the Noticeboard */}
      {stage && board && (
        <button
          className="cs-board"
          style={{ left: board.x, width: board.w, height: board.h, bottom: STAGE_H - board.bottom }}
          title={board.label}
          aria-label={board.label}
          aria-haspopup="dialog"
          aria-expanded={boardOpen}
          onClick={(e) => onBoard(e.currentTarget)}
        />
      )}
      {/* Over the mountain's flags (they move only while one climbs), the ledges' "+n" and the cairn */}
      {stage &&
        spots.flags.map((f, i) => {
          const box = targets[i]
          return (
            <button
              key={f.worktreeId}
              className="cs-flag"
              style={{ left: box.x, bottom: STAGE_H - box.y - box.h, width: box.w, height: box.h }}
              title={flagLabel(f)}
              aria-label={flagLabel(f)}
              aria-haspopup="dialog"
              aria-expanded={openTrail === `flag:${f.worktreeId}`}
              onClick={(e) => onTrail(e.currentTarget, `flag:${f.worktreeId}`, f.worktreeId)}
            />
          )
        })}
      {stage &&
        spots.more.map((m) => (
          <button
            key={m.stage}
            className="cs-flag-more"
            style={{ left: m.x, bottom: STAGE_H - m.y, width: moreBox(m).w, height: moreBox(m).h }}
            title={`${m.count} more at ${STAGES[m.stage]}`}
            aria-label={`${m.count} more trails at ${STAGES[m.stage]}`}
            aria-haspopup="dialog"
            aria-expanded={openTrail === `more:${m.stage}`}
            onClick={(e) => onTrail(e.currentTarget, `more:${m.stage}`)}
          >
            +{m.count}
          </button>
        ))}
      {stage && cairn && (
        <button className="cs-cairn" style={{ left: cairn.x, bottom: STAGE_H - cairn.y - cairn.h, width: cairn.w, height: cairn.h }} title={cairnText(summits)}
          aria-label={cairnText(summits)}
          aria-haspopup="dialog"
          aria-expanded={openTrail === 'cairn'}
          onClick={(e) => onTrail(e.currentTarget, 'cairn')}
        />
      )}
      {/* Under the camps' badges, the dog and the hikers (z-index 0; a swimmer over the lake's button, which would hide it): the stage moves it over the animal */}
      {stage && animal && <AnimalButton key={animal.seq} stage={stage} crossing={animal.crossing} expanded={animalOpen} onAnimal={onAnimal} onGone={onAnimalGone} />}
      {stage && showDog && <button ref={(el) => stage.bindDog(el)} className="cs-dog" title="Pet the dog" aria-label="Pet the dog" onClick={() => stage.petDog()} />}
      {stage &&
        layout.hikers.map((h) => {
          const s = byId.get(h.terminalId)
          if (!s) return null
          const tool = liveTool(Object.hasOwn(tools, s.terminalId) ? tools[s.terminalId] : undefined, now)
          return (
            <button
              key={h.terminalId}
              ref={(el) => stage.bindTarget(h.terminalId, el)}
              className={`cs-camp-hiker${h.place === 'inside' ? ' inside' : ''}`}
              data-terminal={s.terminalId}
              data-label={camperLabel(camp, s) || undefined}
              aria-label={hikerTooltip(s, choreFor(s.terminalId, now, tool), camp ? crewLabel(camp, s.terminalId) : undefined, tool)}
              aria-haspopup="dialog"
              aria-expanded={openCamper === s.terminalId}
              onClick={(e) => onCamper(s.terminalId, e.currentTarget)}
            />
          )
        })}
    </>
  )
}

/**
 * A sighting's animal button (keyed by the sighting). When it unmounts with the focus (its crossing
 * ended), `onGone` moves the focus on: the layout cleanup of a deleted component runs before React
 * removes its button, so the button still has the focus then
 */
function AnimalButton({ stage, crossing, expanded, onAnimal, onGone }: { stage: CampStage; crossing: Crossing; expanded: boolean; onAnimal: Props['onAnimal']; onGone: () => void }): React.JSX.Element {
  const button = useRef<HTMLButtonElement | null>(null)
  const gone = useRef(onGone)
  gone.current = onGone
  useLayoutEffect(
    () => () => {
      if (button.current !== null && button.current === document.activeElement) gone.current()
    },
    []
  )
  return (
    <button
      ref={(el) => {
        button.current = el
        stage.bindAnimal(el)
      }}
      className={crossing.move === 'swimmer' ? 'cs-animal swimmer' : 'cs-animal'}
      style={{ width: crossing.w, height: crossing.h }}
      title={animalLabel(crossing.species)}
      aria-label={animalLabel(crossing.species)}
      aria-haspopup="dialog"
      aria-expanded={expanded}
      onClick={(e) => onAnimal(crossing.species, e.currentTarget)}
    />
  )
}
