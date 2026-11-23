// The campsite strip along the bottom of the window: a night scene with the fire in the middle, a
// tent per worktree with sessions, Global on a log, every session's hiker, the camp dog and the
// camp's buildings at the two ends, drawn by Pixi (scene/PixiStrip.tsx). Tent signs, camp badges
// and their popover are DOM over it. Click a hiker to show its session. The header's counts (and
// each building) open the camp's popover: build and hire. Collapsed, it is one line: everyone at
// tab size, those waiting first.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePluginHost } from '../../../src/shared/plugins/client.ts'
import { placeBuildings } from '../shared/campEdges.ts'
import { BUILDING_IDS, building, type BuildingId } from '../shared/catalog.ts'
import { crewLabel } from '../shared/crew.ts'
import { campCounts, campLayout, campSummary, collapsedRow, type FireSide } from '../shared/layout.ts'
import { hikerLabel, isWaiting } from '../shared/pose.ts'
import { CampPopover, type OpenCamp } from './CampPopover.tsx'
import { campStore } from './campStore.ts'
import { useCamp, useDocumentHidden, useNow, usePrefs, useSeen, useSelected, useSessions, useWidth } from './hooks.ts'
import { MiniHiker } from './MiniHiker.tsx'
import { PixiStrip } from './scene/PixiStrip.tsx'
import { CampLog, Tent, TentPopover, type OpenTent } from './Tent.tsx'

/**
 * The tiers as a string (before the camp's state loads, or from an older server: nothing built), so
 * the tiers, the edges and the layout stay the same objects through a push that changes only the wood
 */
const tiersKey = (built: Readonly<Record<BuildingId, number>> | undefined): string => BUILDING_IDS.map((id) => built?.[id] ?? building(id).start).join(',')
function tiersOf(key: string): Record<BuildingId, number> {
  const tiers = key.split(',').map(Number)
  return Object.fromEntries(BUILDING_IDS.map((id, i) => [id, tiers[i]])) as Record<BuildingId, number>
}

export function Campsite(): React.JSX.Element | null {
  const host = usePluginHost()
  const [{ loaded, prefs }, setPref] = usePrefs(host)
  const sessions = useSessions(host)
  const camp = useCamp(host)
  useSeen(host)
  const selected = useSelected(host)
  const now = useNow()
  const hidden = useDocumentHidden()
  const [ref, width] = useWidth<HTMLDivElement>()
  // The collapsed bar's row of hikers: measured, to know how many fit
  const [rowRef, rowWidth] = useWidth<HTMLDivElement>()
  const [openTent, setOpenTent] = useState<OpenTent | null>(null)
  const badge = useRef<HTMLButtonElement | null>(null)
  const builtKey = tiersKey(camp?.built)
  const built = useMemo(() => tiersOf(builtKey), [builtKey])
  // Camps beat buildings: the ends give way until the middle shows every camp the bare strip would
  const edges = useMemo(() => placeBuildings(built, width, sessions), [built, width, sessions])
  const { left: reserveLeft, right: reserveRight } = edges.reserve
  const layout = useMemo(() => campLayout(sessions, width, { left: reserveLeft, right: reserveRight }), [sessions, width, reserveLeft, reserveRight])
  const closeTent = useCallback((refocus: boolean) => {
    setOpenTent(null)
    if (refocus) badge.current?.focus()
  }, [])
  useCloseOnOutside(openTent !== null, closeTent)
  // The camp's popover, and what opened it (the counts, or a building)
  const [campOpen, setCampOpen] = useState<OpenCamp | null>(null)
  const campOpener = useRef<HTMLElement | null>(null)
  const closeCamp = useCallback((refocus: boolean) => {
    setCampOpen(null)
    if (refocus) campOpener.current?.focus()
  }, [])
  // Out of grouped mode, or its tent gone: nothing to show
  const openGone =
    openTent !== null &&
    (!layout.grouped || (openTent.worktreeId === null ? layout.log === null : !layout.tents.some((t) => t.worktreeId === openTent.worktreeId)))
  useEffect(() => {
    if (openGone) setOpenTent(null)
  }, [openGone])
  // The toggle is a different element collapsed and expanded: after a press, focus follows it to the new one
  const toggle = useRef<HTMLButtonElement | null>(null)
  const pressed = useRef(false)
  useEffect(() => {
    if (!pressed.current) return
    pressed.current = false
    toggle.current?.focus()
  }, [prefs.campsiteCollapsed])
  const flip = (collapsed: boolean): void => {
    pressed.current = true
    setPref('campsiteCollapsed', collapsed)
  }
  if (!loaded || !prefs.showCampsite) return null

  /** Opens the camp above `el` at `focus`'s row; the same opener again closes it */
  const openCamp = (el: HTMLElement, focus: BuildingId | null): void => {
    campOpener.current = el
    const r = el.getBoundingClientRect()
    setCampOpen((o) => (o !== null && o.focus === focus ? null : { left: r.left, top: r.top, focus }))
  }
  const campButton = camp && (
    <button className="cs-camp-button" title="Open the camp" aria-haspopup="dialog" aria-expanded={campOpen !== null} onClick={(e) => openCamp(e.currentTarget, null)}>
      {campCounts(camp)}
    </button>
  )
  // Fixed to the window, so neither the collapsed bar nor the stage clips it
  const campPopover = camp && campOpen && <CampPopover key={campOpen.focus ?? 'camp'} camp={camp} at={campOpen} sessions={sessions} store={campStore(host)} onClose={closeCamp} />

  if (prefs.campsiteCollapsed) {
    const waiting = sessions.filter(isWaiting)
    const row = collapsedRow(sessions, rowWidth)
    return (
      <div className={`campsite collapsed${hidden ? ' cs-paused' : ''}`}>
        <button ref={toggle} className="cs-toggle" title="Show the campsite" aria-label="Show the campsite" onClick={() => flip(false)}>
          <Chevron up />
        </button>
        <span className="cs-summary">{campSummary(sessions)}</span>
        {campButton}
        {waiting.length > 0 && (
          <button className="cs-waiting-chip" title={`Show ${hikerLabel(waiting[0])}`} onClick={() => host.focusSession(waiting[0].terminalId)}>
            {waiting.length} waiting
          </button>
        )}
        <div ref={rowRef} className="cs-mini-row">
          {row.shown.map((s) => (
            <MiniHiker key={s.terminalId} session={s} now={now} crew={camp ? crewLabel(camp, s.terminalId) : undefined} onClick={() => host.focusSession(s.terminalId)} />
          ))}
          {row.more > 0 && <span className="cs-mini-more">+{row.more}</span>}
        </div>
        {campPopover}
      </div>
    )
  }

  const spotted = new Set(layout.hikers.map((h) => h.terminalId))
  const unspottedWaiting = layout.moreWaiting > 0 ? sessions.find((s) => isWaiting(s) && !spotted.has(s.terminalId)) : undefined
  // The open camp's name ('Global' for the log), while it is still drawn
  const popName = !openTent || openGone ? undefined : openTent.worktreeId === null ? 'Global' : layout.tents.find((t) => t.worktreeId === openTent.worktreeId)?.name
  const toggleCamp = (worktreeId: string | null, el: HTMLButtonElement, side: FireSide): void => {
    badge.current = el
    const r = el.getBoundingClientRect()
    setOpenTent((o) => (o !== null && o.worktreeId === worktreeId ? null : { worktreeId, left: r.left, right: r.right, top: r.top, side }))
  }
  return (
    <div ref={ref} className={`campsite${hidden ? ' cs-paused' : ''}`}>
      <div className="cs-header">
        <button ref={toggle} className="cs-toggle" title="Hide the campsite" aria-label="Hide the campsite" onClick={() => flip(true)}>
          <Chevron />
        </button>
        <span className="cs-summary">{campSummary(sessions, layout.moreTents)}</span>
        {campButton}
      </div>
      {width > 0 && (
        <div className="cs-stage">
          {layout.moreWaiting > 0 && (
            <button
              className="cs-more cs-more-waiting"
              style={{ left: layout.fireX }}
              title={unspottedWaiting ? `Show ${hikerLabel(unspottedWaiting)}` : undefined}
              onClick={() => unspottedWaiting && host.focusSession(unspottedWaiting.terminalId)}
            >
              +{layout.moreWaiting} waiting
            </button>
          )}
          {layout.log && <CampLog log={layout.log} grouped={layout.grouped} open={openTent !== null && openTent.worktreeId === null} onToggle={(el) => toggleCamp(null, el, 'left')} />}
          {layout.tents.map((t) => (
            <Tent
              key={t.worktreeId}
              tent={t}
              grouped={layout.grouped}
              open={openTent !== null && openTent.worktreeId === t.worktreeId}
              onToggle={(el) => toggleCamp(t.worktreeId, el, t.x < layout.fireX ? 'left' : 'right')}
            />
          ))}
          {/* After the camps' badges in tab order, as the dog and hikers were; the canvas sits under everything (z-index 0) */}
          <PixiStrip
            layout={layout}
            edges={edges}
            built={built}
            sessions={sessions}
            camp={camp}
            now={now}
            selected={selected}
            paused={hidden}
            showDog={prefs.showDog}
            onPick={(id) => host.focusSession(id)}
            onBuilding={(id, el) => openCamp(el, id)}
          />
          {sessions.length === 0 && <span className="cs-empty">Nobody at camp yet. Start a session and a hiker walks in.</span>}
        </div>
      )}
      {/* Beside the stage, not in it: fixed to the window, and nothing of the stage's can clip it */}
      {openTent && popName !== undefined && (
        <TentPopover
          key={openTent.worktreeId === null ? 'global' : `worktree:${openTent.worktreeId}`}
          at={openTent}
          name={popName}
          members={sessions.filter((s) => s.worktreeId === openTent.worktreeId)}
          now={now}
          onPick={(id) => {
            setOpenTent(null)
            host.focusSession(id)
          }}
        />
      )}
      {campPopover}
    </div>
  )
}

/** While `open`: a press outside the camps' badges and the popover, or a window resize, closes; Escape closes and refocuses the badge */
function useCloseOnOutside(open: boolean, close: (refocus: boolean) => void): void {
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent): void => {
      if (!(e.target instanceof Element) || !e.target.closest('.cs-camp-badge, .cs-tent-popover')) close(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close(true)
    }
    const onResize = (): void => close(false)
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    window.addEventListener('resize', onResize)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', onResize)
    }
  }, [open, close])
}

function Chevron({ up = false }: { up?: boolean }): React.JSX.Element {
  return (
    <svg width={12} height={12} viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={up ? 'M2.5 7.5 6 4l3.5 3.5' : 'M2.5 4.5 6 8l3.5-3.5'} />
    </svg>
  )
}
