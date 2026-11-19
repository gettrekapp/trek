// The campsite strip along the bottom of the window: a night scene with the fire in the middle, a
// tent per worktree with sessions, Global on a log, and every session's hiker. Click a hiker to
// show its session. Collapsed, it is one line: everyone at tab size, those waiting first.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePluginHost, type PluginSession } from '../../../src/shared/plugins/client.ts'
import { campLayout, campSummary, collapsedRow, type CampHikerSpot, type FireSide } from '../shared/layout.ts'
import { choreFor, hikerLabel, isWaiting } from '../shared/pose.ts'
import { CampHiker, offstage, WALK_MS } from './CampHiker.tsx'
import { CampScene } from './CampScene.tsx'
import { useDocumentHidden, useNow, usePrefs, useSelected, useSessions, useWidth } from './hooks.ts'
import { MiniHiker } from './MiniHiker.tsx'
import { CampLog, Tent, TentPopover, type OpenTent } from './Tent.tsx'

export function Campsite(): React.JSX.Element | null {
  const host = usePluginHost()
  const [{ loaded, prefs }, setPref] = usePrefs(host)
  const sessions = useSessions(host)
  const selected = useSelected(host)
  const now = useNow()
  const hidden = useDocumentHidden()
  const [ref, width] = useWidth<HTMLDivElement>()
  // The collapsed bar's row of hikers: measured, to know how many fit
  const [rowRef, rowWidth] = useWidth<HTMLDivElement>()
  const [openTent, setOpenTent] = useState<OpenTent | null>(null)
  const badge = useRef<HTMLButtonElement | null>(null)
  const layout = useMemo(() => campLayout(sessions, width), [sessions, width])
  const departing = useDepartures(sessions, layout.hikers, width)
  const known = useKnownSessions(sessions, width)
  const closeTent = useCallback((refocus: boolean) => {
    setOpenTent(null)
    if (refocus) badge.current?.focus()
  }, [])
  useCloseOnOutside(openTent !== null, closeTent)
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

  if (prefs.campsiteCollapsed) {
    const waiting = sessions.filter(isWaiting)
    const row = collapsedRow(sessions, rowWidth)
    return (
      <div className={`campsite collapsed${hidden ? ' cs-paused' : ''}`}>
        <button ref={toggle} className="cs-toggle" title="Show the campsite" aria-label="Show the campsite" onClick={() => flip(false)}>
          <Chevron up />
        </button>
        <span className="cs-summary">{campSummary(sessions)}</span>
        {waiting.length > 0 && (
          <button className="cs-waiting-chip" title={`Show ${hikerLabel(waiting[0])}`} onClick={() => host.focusSession(waiting[0].terminalId)}>
            {waiting.length} waiting
          </button>
        )}
        <div ref={rowRef} className="cs-mini-row">
          {row.shown.map((s) => (
            <MiniHiker key={s.terminalId} session={s} now={now} onClick={() => host.focusSession(s.terminalId)} />
          ))}
          {row.more > 0 && <span className="cs-mini-more">+{row.more}</span>}
        </div>
      </div>
    )
  }

  const byId = new Map(sessions.map((s) => [s.terminalId, s]))
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
      <CampScene />
      <div className="cs-header">
        <button ref={toggle} className="cs-toggle" title="Hide the campsite" aria-label="Hide the campsite" onClick={() => flip(true)}>
          <Chevron />
        </button>
        <span className="cs-summary">{campSummary(sessions, layout.moreTents)}</span>
      </div>
      {width > 0 && (
        <div className="cs-stage">
          {/* Out with no sessions: stones and logs, no flames or glow */}
          <div className={`cs-fire${sessions.length === 0 ? ' cold' : ''}`} style={{ left: layout.fireX - 23 }} aria-hidden="true">
            <i className="cs-ember a" />
            <i className="cs-ember b" />
            <div className="cs-flames">
              <span />
              <span />
              <span />
            </div>
            <div className="cs-hearth">
              <b />
              <b />
              <em />
              <b />
              <b />
            </div>
          </div>
          {sessions.length > 0 && <div className="cs-glow" style={{ left: layout.fireX - 70 }} aria-hidden="true" />}
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
          {layout.hikers.map((h) => {
            const s = byId.get(h.terminalId)
            if (!s) return null
            return (
              <CampHiker
                key={h.terminalId}
                session={s}
                x={h.x}
                // Already at camp: appears in place; new since the strip first laid out: walks in
                startX={known(h.terminalId) ? h.x : undefined}
                place={h.place}
                width={width}
                chore={choreFor(s.terminalId, now)}
                selected={selected === s.terminalId}
                onClick={() => host.focusSession(s.terminalId)}
              />
            )
          })}
          {departing.map((d) => (
            <CampHiker key={`gone:${d.seq}`} session={d.session} x={d.x} startX={d.from} place="tent" width={width} chore="map" selected={false} leaving />
          ))}
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
    </div>
  )
}

/**
 * Whether a session was already there: at the strip's first measured layout, or any render since
 * (collapsed or hidden too). Those appear in place when the strip mounts, expands or leaves grouped
 * mode; only sessions new since walk in.
 */
function useKnownSessions(sessions: readonly PluginSession[], width: number): (terminalId: string) => boolean {
  const seen = useRef<Set<string> | null>(null)
  const measured = width > 0 || seen.current !== null
  useEffect(() => {
    if (!measured) return
    seen.current ??= new Set()
    for (const s of sessions) seen.current.add(s.terminalId)
  }, [sessions, measured])
  // Before the first measured layout has committed, everyone counts as already there
  return (id) => seen.current === null || seen.current.has(id)
}

/** A closed session's hiker, walking off to the nearer edge for WALK_MS */
interface Departure {
  /** Unique per departure (a key) */
  seq: number
  session: PluginSession
  /** Where it stood */
  from: number
  /** The edge it walks to */
  x: number
}

let departures = 0

function useDepartures(sessions: readonly PluginSession[], spots: readonly CampHikerSpot[], width: number): Departure[] {
  const last = useRef(new Map<string, { session: PluginSession; x: number }>())
  const [departing, setDeparting] = useState<Departure[]>([])
  // Each walk-off's own timer, so a later change (a status, a resize) can't cut one short
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>())
  useEffect(() => {
    const byId = new Map(sessions.map((s) => [s.terminalId, s]))
    const current = new Map<string, { session: PluginSession; x: number }>()
    for (const h of spots) {
      const s = byId.get(h.terminalId)
      if (s) current.set(h.terminalId, { session: s, x: h.x })
    }
    const gone: Departure[] = [...last.current.values()]
      .filter((p) => !byId.has(p.session.terminalId))
      .map((p) => ({ seq: ++departures, session: p.session, from: p.x, x: offstage(p.x, width) }))
    last.current = current
    // A session back under the same id is at camp again, not leaving
    setDeparting((d) => {
      const kept = d.filter((x) => !byId.has(x.session.terminalId))
      return gone.length === 0 && kept.length === d.length ? d : [...kept, ...gone]
    })
    if (gone.length === 0) return
    const ids = new Set(gone.map((g) => g.seq))
    const timer = setTimeout(() => {
      timers.current.delete(timer)
      setDeparting((d) => d.filter((x) => !ids.has(x.seq)))
    }, WALK_MS)
    timers.current.add(timer)
  }, [sessions, spots, width])
  useEffect(() => {
    const pending = timers.current
    return () => {
      for (const t of pending) clearTimeout(t)
      pending.clear()
    }
  }, [])
  return departing
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
