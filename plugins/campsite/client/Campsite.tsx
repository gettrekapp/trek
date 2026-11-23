// The campsite strip along the bottom of the window: a night scene with the fire in the middle, a
// tent per worktree with sessions, Global on a log, every session's hiker, the camp dog, the
// camp's buildings at the two ends, and behind the fire the trails' mountain with a flag for each of
// this project's trails and the cairn of summits, drawn by Pixi (scene/PixiStrip.tsx). Tent signs,
// camp badges and their popover are DOM over it. Click a hiker to show its session. The header's
// counts (and each building) open the camp's popover: build and hire; a flag, the cairn or the
// signpost opens its Trails tab. A summit here (the server's `summit` event) climbs its flag,
// raises sparks and says so in the header for a few seconds. The world (part 3d-1): the sky follows
// this window's clock and the seasons the month (both settings), and the weather this project's
// trails and activity, with a glyph after the counts saying why. Wildlife (part 3d-2): a sighting
// here (the server's `sighting` event) sends its animal across the expanded, visible strip, one at a
// time; its button opens the field guide (the popover's Guide tab) at it. Agents (part 5): this
// project's notes are read whenever its newest note's time changes; once it has one, a noticeboard
// stands on the expanded strip (a free spot near the fire; a red pin while one is unread) and opens
// the Noticeboard (the popover's Camp tab), which marks them seen. Collapsed, it is one line:
// everyone at tab size, those waiting first.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { usePluginHost } from '../../../src/shared/plugins/client.ts'
import { boardSpot } from '../shared/board.ts'
import { placeBuildings } from '../shared/campEdges.ts'
import { BUILDING_IDS, building, type BuildingId } from '../shared/catalog.ts'
import { crewLabel, kitsKey, kitsOf } from '../shared/crew.ts'
import { admit, crossing, occupiedSpans, type Crossing, type SightingView, type Span } from '../shared/crossing.ts'
import { boardLabel, guideSeenNow, notesSeenNow, projectNoteAt, summitLine, unreadNotes, weatherBadge } from '../shared/campView.ts'
import { campCounts, campLayout, campSummary, collapsedRow, type FireSide } from '../shared/layout.ts'
import { SUMMIT_FRESH_MS, flagsKey, flagsOf, mountain, peakClear } from '../shared/mountain.ts'
import { hikerLabel, isWaiting } from '../shared/pose.ts'
import { seasonAt, weatherOf, worldAt, worldKey } from '../shared/world.ts'
import { AwayCard } from './AwayCard.tsx'
import { CampPopover, type CampTab, type OpenCamp } from './CampPopover.tsx'
import { campStore } from './campStore.ts'
import { useCamp, useDocumentHidden, useNotes, useNow, usePrefs, useReducedMotion, useSeen, useSelected, useSessions, useTools, useWidth } from './hooks.ts'
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

/** The header's weather glyph: its fixed width (.cs-weather) and the end group's gap (.cs-header-end) */
const GLYPH_W = 26
const HEADER_GAP = 6
/** Slack so a sub-pixel change in the measured need can't flip the glyph on and off at the exact threshold */
const GLYPH_SLACK = 2

/**
 * The least room the expanded header's end group needs without the weather glyph: the counts
 * button, the away card without its text (which is cut short) and the summit's line without its
 * text (padding only), and the gaps between them. The glyph is shown only when it fits beside that.
 */
function endGroupNeeds(end: HTMLElement): number {
  let total = 0
  let items = 0
  for (const el of end.children) {
    if (!(el instanceof HTMLElement) || el.classList.contains('cs-weather')) continue
    let w: number
    if (el.classList.contains('cs-summit-line')) {
      // Empty, it is out of the flex row (no room, no gap)
      if (el.textContent === '') continue
      const style = getComputedStyle(el)
      w = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight)
    } else if (el.classList.contains('cs-away')) {
      const text = el.querySelector('.cs-away-text')
      w = el.getBoundingClientRect().width - (text?.getBoundingClientRect().width ?? 0)
    } else w = el.getBoundingClientRect().width
    total += w
    items += 1
  }
  return Math.ceil(total + Math.max(0, items - 1) * HEADER_GAP)
}

/** How long the header says "⛳ Summited …" */
const SUMMIT_LINE_MS = 5000

/**
 * The last summit of this window's project (the server's `summit` event), numbered so each one is
 * celebrated; whether the header still says so; whether it is still fresh (SUMMIT_FRESH_MS: only then
 * is it handed to the stage, so a stage made later, the strip expanded again, doesn't replay it)
 */
function useSummit(host: ReturnType<typeof usePluginHost>): { summit: { worktreeId: string; branch: string; seq: number } | null; shown: boolean; fresh: boolean } {
  const [summit, setSummit] = useState<{ worktreeId: string; branch: string; seq: number } | null>(null)
  const [shown, setShown] = useState(false)
  const [fresh, setFresh] = useState(false)
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
    setFresh(true)
    const line = setTimeout(() => setShown(false), SUMMIT_LINE_MS)
    const stale = setTimeout(() => setFresh(false), SUMMIT_FRESH_MS)
    return () => {
      clearTimeout(line)
      clearTimeout(stale)
    }
  }, [summit])
  return { summit, shown, fresh }
}

/** What a sighting needs to know of the strip when it arrives */
interface StripView extends SightingView {
  lake: { x: number; w: number } | null
  reduced: boolean
  /** What hides a still walker (the tents, the log, the fire, the buildings) */
  occupied: readonly Span[]
}

/**
 * The sighting's animal crossing the strip now (part 3d-2): a `sighting` event this window admits
 * (shared/crossing.ts: this project's, a species it can draw, no animal up, the strip expanded and
 * visible) starts one, its crossing worked out for the strip as it is then; it is logged on the
 * server either way. It goes once its crossing is over, or at once when the strip collapses or is
 * turned off, its width or the lake's place changes (the crossing would no longer fit it), or
 * reduced motion is turned on or off.
 */
function useAnimal(host: ReturnType<typeof usePluginHost>, view: StripView): { seq: number; crossing: Crossing } | null {
  const [animal, setAnimal] = useState<{ seq: number; crossing: Crossing } | null>(null)
  const current = useRef({ animal, view })
  current.current = { animal, view }
  const seq = useRef(0)
  useEffect(
    () =>
      host.onEvent<{ projectId?: unknown; species?: unknown; dir?: unknown }>('sighting', (e) => {
        const { animal: now, view: v } = current.current
        const ok = admit(e, v, now !== null)
        if (!ok) return
        const c = crossing(ok.species, ok.dir, v.width, v.lake, Math.random(), v.reduced, v.occupied)
        if (c) setAnimal({ seq: ++seq.current, crossing: c })
      }),
    [host]
  )
  useEffect(() => {
    if (!animal) return
    const gone = setTimeout(() => setAnimal(null), animal.crossing.ms)
    return () => clearTimeout(gone)
  }, [animal])
  const lakeKey = view.lake ? `${view.lake.x}:${view.lake.w}` : ''
  useEffect(() => {
    setAnimal(null)
  }, [view.shown, view.collapsed, view.width, lakeKey, view.reduced])
  return animal
}

export function Campsite(): React.JSX.Element | null {
  const host = usePluginHost()
  const [{ loaded, prefs }, setPref] = usePrefs(host)
  const sessions = useSessions(host)
  const camp = useCamp(host)
  // A hidden strip is time away from the camp: no pings
  useSeen(host, loaded && prefs.showCampsite, prefs.seasons)
  const selected = useSelected(host)
  const now = useNow()
  // Each session's latest tool call (part 4): the hikers' chores
  const tools = useTools(host)
  const hidden = useDocumentHidden()
  const reduced = useReducedMotion()
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
  const { summit, shown: summitShown, fresh: summitFresh } = useSummit(host)
  // This project's notes (part 5): read again whenever its newest note's time changes (none: never asked)
  const noteAt = projectNoteAt(camp?.noteAt, host.projectId)
  const notes = useNotes(host)
  useEffect(() => {
    if (noteAt !== undefined) campStore(host).loadNotes()
  }, [host, noteAt])
  // The world (part 3d-1): this window's clock and prefs; this project's weather from its trails' checks and its last activity.
  // Not memoised: it depends on the clock (the 24 h rain and 12 h fog run out as `now` moves), and it is
  // a short scan of the trails; what it feeds is keyed (the world below, the badge's strings)
  const season = seasonAt(new Date(now), prefs.seasons)
  const weather = weatherOf(camp?.trails ?? [], camp?.lastActive ?? {}, host.projectId, now, season)
  const nextWorld = worldAt(now, prefs.sky, prefs.seasons, weather.kind)
  const worldK = worldKey(nextWorld)
  // The same object while the world looks the same (the 5 s clock ticks on): the stage redraws its backdrop only when it changes
  const world = useMemo(() => nextWorld, [worldK]) // eslint-disable-line react-hooks/exhaustive-deps
  // Only while fresh: a stage's actors start with no summit seen and would celebrate an old one
  const stageSummit = useMemo(() => (summitFresh && summit ? { worktreeId: summit.worktreeId, seq: summit.seq } : null), [summit, summitFresh])
  // Camps beat buildings: the ends give way until the middle shows every camp the bare strip would
  const edges = useMemo(() => placeBuildings(built, width, sessions), [built, width, sessions])
  const { left: reserveLeft, right: reserveRight } = edges.reserve
  const layout = useMemo(() => campLayout(sessions, width, { left: reserveLeft, right: reserveRight }), [sessions, width, reserveLeft, reserveRight])
  // The noticeboard (part 5), once this project has a note: clear of the camps and buildings, and of the empty camp's line of text (centred, ~380 px of 11 px type)
  const hasNotes = noteAt !== undefined
  const empty = sessions.length === 0
  const spot = useMemo(() => (hasNotes ? boardSpot(layout, [...edges.left, ...edges.right], empty ? [{ from: width / 2 - 200, to: width / 2 + 200 }] : []) : null), [hasNotes, layout, edges, empty, width])
  const unread = noteAt !== undefined && noteAt > prefs.notesSeenAt
  const counted = unreadNotes(notes.list, prefs.notesSeenAt)
  const label = boardLabel(!unread ? 0 : counted > 0 ? counted : null)
  const board = useMemo(() => (spot ? { ...spot, unread, label } : null), [spot, unread, label])
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
  // The counts button (collapsed or expanded): focus goes back to it when the away card is dismissed
  const countsButton = useRef<HTMLButtonElement | null>(null)
  const closeCamp = useCallback((refocus: boolean) => {
    setCampOpen(null)
    if (!refocus) return
    // An animal that opened it may have gone since: the counts then
    const opener = campOpener.current
    if (opener?.isConnected) opener.focus()
    else countsButton.current?.focus()
  }, [])
  const lakeSpot = edges.right.find((p) => p.id === 'lake')
  const animal = useAnimal(host, {
    projectId: host.projectId,
    shown: loaded && prefs.showCampsite,
    collapsed: prefs.campsiteCollapsed,
    hidden,
    width,
    lake: lakeSpot ? { x: lakeSpot.x, w: lakeSpot.w } : null,
    reduced,
    occupied: occupiedSpans(layout, [...edges.left, ...edges.right])
  })
  // The expanded header's end group, and the least room it needs without the weather glyph (measured after each render)
  const headerEnd = useRef<HTMLDivElement | null>(null)
  const [endNeeds, setEndNeeds] = useState(0)
  useLayoutEffect(() => {
    const end = headerEnd.current
    const needs = end ? endGroupNeeds(end) : 0
    setEndNeeds((n) => (n === needs ? n : needs))
  })
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

  /** Opens the camp above `el`: at `focus`'s row, or at a tab (and a trail or a species in it); the same opener again closes it, another one moves it there */
  const openCamp = (el: HTMLElement, focus: BuildingId | null, tab?: CampTab, trail?: string, opener?: string, species?: string): void => {
    campOpener.current = el
    const r = el.getBoundingClientRect()
    const next: OpenCamp = { left: r.left, top: r.top, focus, tab, trail, opener, species }
    setCampOpen((o) => (o !== null && openKey(o) === openKey(next) ? null : next))
  }
  /** The Trails tab from `opener` (the signpost, a flag, a ledge's "+n" or the cairn), at a trail of this project or at its top */
  const openTrails = (el: HTMLElement, opener: string, trail?: string): void => openCamp(el, null, 'trails', trail, opener)
  const sky = weatherBadge(weather)
  // After the counts: why it rains, snows or is foggy over this project's camp (also in the counts' title and label, for when the glyph is dropped and for the keyboard)
  const weatherGlyph = sky && (
    <span className="cs-weather" role="img" title={sky.text} aria-label={sky.text}>
      {sky.glyph}
    </span>
  )
  const campButton = camp && (
    <button
      ref={countsButton}
      className="cs-camp-button"
      title={sky ? `Open the camp · ${sky.text}` : 'Open the camp'}
      aria-label={sky ? `${campCounts(camp)} · ${sky.text}` : undefined}
      aria-haspopup="dialog"
      aria-expanded={campOpen !== null && openKey(campOpen) === 'camp:'}
      onClick={(e) => openCamp(e.currentTarget, null)}
    >
      {campCounts(camp)}
    </button>
  )
  // Fixed to the window, so neither the collapsed bar nor the stage clips it
  const campPopover = camp && campOpen && (
    <CampPopover
      key={openKey(campOpen)}
      camp={camp}
      at={campOpen}
      sessions={sessions}
      projectId={host.projectId}
      store={campStore(host)}
      guideSeenAt={prefs.guideSeenAt}
      onGuideSeen={() => setPref('guideSeenAt', guideSeenNow(camp.guide, Date.now()))}
      notes={notes}
      onNotesSeen={() => {
        // Only when something is unread: opening the camp shouldn't write the prefs each time
        if (noteAt !== undefined && noteAt > prefs.notesSeenAt) setPref('notesSeenAt', notesSeenNow(noteAt, Date.now()))
      }}
      onClose={closeCamp}
    />
  )
  // A live region kept mounted (empty, it takes no room) and filled for a few seconds, so the line is announced
  const summitNote = (
    <span className="cs-summit-line" role="status">
      {summitShown && summit ? summitLine(summit.branch) : null}
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
        {weatherGlyph}
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
  // Right of the peak's keep-out band; the glyph goes before the counts would be pushed into it
  const endRoom = Math.max(0, width - 8 - clear.right)
  const glyphFits = width > 0 && endNeeds + (endNeeds > 0 ? HEADER_GAP : 0) + GLYPH_W + GLYPH_SLACK <= endRoom
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
        <div ref={headerEnd} className="cs-header-end" style={width > 0 ? { maxWidth: endRoom } : undefined}>
          {campButton}
          {glyphFits && weatherGlyph}
          {summitNote}
          {awayCard}
        </div>
      </div>
      {width > 0 && (
        <div className="cs-stage" data-phase={world.phase} data-season={world.season ?? 'none'} data-weather={world.weather}>
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
            tools={tools}
            world={world}
            selected={selected}
            paused={hidden}
            showDog={prefs.showDog}
            onPick={(id) => host.focusSession(id)}
            onBuilding={(id, el) => (id === 'signpost' ? openTrails(el, 'signpost') : openCamp(el, id))}
            onTrail={(el, opener, worktreeId) => openTrails(el, opener, worktreeId)}
            openTrail={campOpen?.tab === 'trails' ? (campOpen.opener ?? null) : null}
            animal={animal}
            onAnimal={(species, el) => openCamp(el, null, 'guide', undefined, 'animal', species)}
            animalOpen={campOpen?.opener === 'animal' && campOpen.species === animal?.crossing.species}
            onAnimalGone={() => countsButton.current?.focus()}
            board={board}
            onBoard={(el) => openCamp(el, null, 'camp', undefined, 'board')}
            boardOpen={campOpen?.opener === 'board'}
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

/** Where the camp popover opens, as a key: its tab, its building row, trail or species, and what opened it ("camp:", "camp:lights", "trails:@signpost", "trails:w1@flag:w1", "guide:fox@animal") */
const openKey = (o: OpenCamp): string => `${o.tab ?? 'camp'}:${o.trail ?? o.species ?? o.focus ?? ''}${o.opener === undefined ? '' : `@${o.opener}`}`

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
