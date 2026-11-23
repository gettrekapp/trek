// The campsite strip along the bottom of the window: a night scene with the fire in the middle, a
// tent per worktree with sessions, Global on a log, every session's hiker, the camp dog, the
// camp's buildings at the two ends, and behind the fire the trails' mountain with a flag for each of
// this project's trails and the cairn of summits, drawn by Pixi (scene/PixiStrip.tsx). Tent signs,
// camp badges and their popover are DOM over it. Click a hiker to show its session. The header's
// counts (and each building) open the camp's popover: build and hire; a flag, the cairn or the
// signpost opens its Trails tab. A summit here (the server's `summit` event) climbs its flag,
// raises sparks and says so in the header for a few seconds. Collapsed, it is one line: everyone at
// tab size, those waiting first.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePluginHost } from '../../../src/shared/plugins/client.ts'
import { placeBuildings } from '../shared/campEdges.ts'
import { BUILDING_IDS, building, type BuildingId } from '../shared/catalog.ts'
import { crewLabel, kitsKey, kitsOf } from '../shared/crew.ts'
import { summitLine } from '../shared/campView.ts'
import { campCounts, campLayout, campSummary, collapsedRow, type FireSide } from '../shared/layout.ts'
import { flagsKey, flagsOf, mountain, peakClear } from '../shared/mountain.ts'
import { hikerLabel, isWaiting } from '../shared/pose.ts'
import { AwayCard } from './AwayCard.tsx'
import { CampPopover, type CampTab, type OpenCamp } from './CampPopover.tsx'
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

/** How long the header says "⛳ Summited …" */
const SUMMIT_LINE_MS = 5000

/** The last summit of this window's project (the server's `summit` event), numbered so each one is celebrated; whether the header still says so */
function useSummit(host: ReturnType<typeof usePluginHost>): { summit: { worktreeId: string; branch: string; seq: number } | null; shown: boolean } {
  const [summit, setSummit] = useState<{ worktreeId: string; branch: string; seq: number } | null>(null)
  const [shown, setShown] = useState(false)
  useEffect(
    () =>
      host.onEvent<{ projectId?: unknown; worktreeId?: unknown; branch?: unknown }>('summit', (e) => {
        if (e.projectId !== host.projectId || typeof e.worktreeId !== 'string' || typeof e.branch !== 'string') return
        const { worktreeId, branch } = e
        setSummit((s) => ({ worktreeId, branch, seq: (s?.seq ?? 0) + 1 }))
      }),
    [host]
  )
  useEffect(() => {
    if (!summit) return
    setShown(true)
    const timer = setTimeout(() => setShown(false), SUMMIT_LINE_MS)
    return () => clearTimeout(timer)
  }, [summit])
  return { summit, shown }
}

export function Campsite(): React.JSX.Element | null {
  const host = usePluginHost()
  const [{ loaded, prefs }, setPref] = usePrefs(host)
  const sessions = useSessions(host)
  const camp = useCamp(host)
  // A hidden strip is time away from the camp: no pings
  useSeen(host, loaded && prefs.showCampsite)
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
  // The members' gear on the strip's hikers: a new object only when someone's gear or a geared member's session changes
  const kitsJson = camp ? kitsKey(camp) : '[]'
  const kits = useMemo(() => kitsOf(kitsJson), [kitsJson])
  // This window's project's trails on the mountain: a new array only when one of its flags changes
  const flagsJson = camp?.trails ? flagsKey(camp.trails, host.projectId) : '[]'
  const trails = useMemo(() => flagsOf(flagsJson), [flagsJson])
  const { summit, shown: summitShown } = useSummit(host)
  const stageSummit = useMemo(() => summit && { worktreeId: summit.worktreeId, seq: summit.seq }, [summit])
  // Camps beat buildings: the ends give way until the middle shows every camp the bare strip would
  const edges = useMemo(() => placeBuildings(built, width, sessions), [built, width, sessions])
  const { left: reserveLeft, right: reserveRight } = edges.reserve
  const layout = useMemo(() => campLayout(sessions, width, { left: reserveLeft, right: reserveRight }), [sessions, width, reserveLeft, reserveRight])
  // The header's controls stay off the peak: its ledges, their "+n" and the cairn (shared/mountain.ts)
  const clear = useMemo(() => peakClear(mountain(layout.fireX, width - reserveLeft - reserveRight)), [layout.fireX, width, reserveLeft, reserveRight])
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
  // The counts button (collapsed or expanded): focus goes back to it when the away card is dismissed
  const countsButton = useRef<HTMLButtonElement | null>(null)
  // The camp's state gone (the plugin's server half went away), or the strip collapsed or expanded: the popover's opener is gone
  const hasCamp = camp !== null
  useEffect(() => {
    setCampOpen(null)
  }, [hasCamp, prefs.campsiteCollapsed])
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

  /** Opens the camp above `el`: at `focus`'s row, or at a tab (and a trail in it); the same opener again closes it */
  const openCamp = (el: HTMLElement, focus: BuildingId | null, tab?: CampTab, trail?: string): void => {
    campOpener.current = el
    const r = el.getBoundingClientRect()
    const next: OpenCamp = { left: r.left, top: r.top, focus, tab, trail }
    setCampOpen((o) => (o !== null && openKey(o) === openKey(next) ? null : next))
  }
  /** The Trails tab, at a trail of this project or at its top */
  const openTrails = (el: HTMLElement, trail?: string): void => openCamp(el, null, 'trails', trail)
  const campButton = camp && (
    <button
      ref={countsButton}
      className="cs-camp-button"
      title="Open the camp"
      aria-haspopup="dialog"
      aria-expanded={campOpen !== null && openKey(campOpen) === 'camp:'}
      onClick={(e) => openCamp(e.currentTarget, null)}
    >
      {campCounts(camp)}
    </button>
  )
  // Fixed to the window, so neither the collapsed bar nor the stage clips it
  const campPopover = camp && campOpen && <CampPopover key={openKey(campOpen)} camp={camp} at={campOpen} sessions={sessions} projectId={host.projectId} store={campStore(host)} onClose={closeCamp} />
  const summitNote = summitShown && summit && (
    <span className="cs-summit-line" role="status">
      {summitLine(summit.branch)}
    </span>
  )
  const awayCard = camp?.away && (
    <AwayCard
      away={camp.away}
      onDismiss={() => {
        // The card goes; its focus would be lost
        countsButton.current?.focus()
        campStore(host)
          .awaySeen()
          .catch(() => {
            // An older server: the card stays until the next push
          })
      }}
    />
  )

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
        {summitNote}
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
        {awayCard}
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
      {/* Left of the peak, the toggle and the summary (cut short); right of it, at the header's end, the counts, the summit's line and the away card (the header starts 6 px in, ends 8 px in) */}
      <div className="cs-header">
        <div className="cs-header-start" style={width > 0 ? { maxWidth: Math.max(0, clear.left - 6) } : undefined}>
          <button ref={toggle} className="cs-toggle" title="Hide the campsite" aria-label="Hide the campsite" onClick={() => flip(true)}>
            <Chevron />
          </button>
          <span className="cs-summary">{campSummary(sessions, layout.moreTents)}</span>
        </div>
        <div className="cs-header-end" style={width > 0 ? { maxWidth: Math.max(0, width - 8 - clear.right) } : undefined}>
          {campButton}
          {summitNote}
          {awayCard}
        </div>
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
            kits={kits}
            trails={trails}
            summits={camp?.summits ?? 0}
            summit={stageSummit}
            now={now}
            selected={selected}
            paused={hidden}
            showDog={prefs.showDog}
            onPick={(id) => host.focusSession(id)}
            onBuilding={(id, el) => (id === 'signpost' ? openTrails(el) : openCamp(el, id))}
            onTrail={(el, worktreeId) => openTrails(el, worktreeId)}
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

/** Where the camp popover opens, as a key: its tab, and its building row or trail ("camp:", "camp:lights", "trails:w1") */
const openKey = (o: OpenCamp): string => `${o.tab ?? 'camp'}:${o.trail ?? o.focus ?? ''}`

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
