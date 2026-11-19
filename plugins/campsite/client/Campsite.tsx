// The campsite strip along the bottom of the window: a night scene with the fire in the middle, a
// tent per worktree with sessions, Global on a log, and every session's hiker. Click a hiker to
// show its session. Collapsed, it is a thin bar of "!" for those waiting.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePluginHost, type PluginSession } from '../../../src/shared/plugins/client.ts'
import { campLayout, type CampHikerSpot } from '../shared/layout.ts'
import { choreFor, hikerLabel, isWaiting } from '../shared/pose.ts'
import { CampHiker, offstage, WALK_MS } from './CampHiker.tsx'
import { CampScene } from './CampScene.tsx'
import { useDocumentHidden, useNow, usePrefs, useSelected, useSessions, useWidth } from './hooks.ts'
import { Tent } from './Tent.tsx'

export function Campsite(): React.JSX.Element | null {
  const host = usePluginHost()
  const [prefs, setPref] = usePrefs(host)
  const sessions = useSessions(host)
  const selected = useSelected(host)
  const now = useNow()
  const hidden = useDocumentHidden()
  const [ref, width] = useWidth<HTMLDivElement>()
  const [openTent, setOpenTent] = useState<string | null>(null)
  const layout = useMemo(() => campLayout(sessions, width), [sessions, width])
  const departing = useDepartures(sessions, layout.hikers, width)
  const closeTent = useCallback(() => setOpenTent(null), [])
  useCloseOnOutside(openTent !== null, closeTent)
  if (!prefs.showCampsite) return null

  if (prefs.campsiteCollapsed) {
    return (
      <div className="campsite collapsed">
        <button className="cs-chevron" title="Show the campsite" aria-label="Show the campsite" onClick={() => setPref('campsiteCollapsed', false)}>
          ▴
        </button>
        {sessions.filter(isWaiting).map((s) => (
          <button key={s.terminalId} className="cs-waiting-chip" title={hikerLabel(s)} onClick={() => host.focusSession(s.terminalId)}>
            !
          </button>
        ))}
      </div>
    )
  }

  const byId = new Map(sessions.map((s) => [s.terminalId, s]))
  const spotted = new Set(layout.hikers.map((h) => h.terminalId))
  const unspottedWaiting = layout.moreWaiting > 0 ? sessions.find((s) => isWaiting(s) && !spotted.has(s.terminalId)) : undefined
  return (
    <div ref={ref} className={`campsite${hidden ? ' cs-paused' : ''}`}>
      <CampScene />
      <button className="cs-chevron" title="Hide the campsite" aria-label="Hide the campsite" onClick={() => setPref('campsiteCollapsed', true)}>
        ▾
      </button>
      {width > 0 && (
        <>
          <div className="cs-fire" style={{ left: layout.fireX - 10 }} aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
          <div className="cs-glow" style={{ left: layout.fireX - 70 }} aria-hidden="true" />
          {layout.moreWaiting > 0 && (
            <button
              className="cs-more cs-more-waiting"
              style={{ left: layout.fireX }}
              title={unspottedWaiting ? `Show ${hikerLabel(unspottedWaiting)}` : undefined}
              onClick={() => unspottedWaiting && host.focusSession(unspottedWaiting.terminalId)}
            >
              +{layout.moreWaiting} waving
            </button>
          )}
          {layout.log && <div className="cs-log" style={{ left: layout.log.x - 36 }} aria-hidden="true" />}
          {layout.tents.map((t) => (
            <Tent
              key={t.worktreeId}
              tent={t}
              grouped={layout.grouped}
              open={openTent === t.worktreeId}
              onToggle={() => setOpenTent((o) => (o === t.worktreeId ? null : t.worktreeId))}
              members={sessions.filter((s) => s.worktreeId === t.worktreeId)}
              onPick={(id) => {
                setOpenTent(null)
                host.focusSession(id)
              }}
            />
          ))}
          {layout.moreTents > 0 && <span className="cs-more">+{layout.moreTents} more camps</span>}
          {layout.hikers.map((h) => {
            const s = byId.get(h.terminalId)
            if (!s) return null
            return (
              <CampHiker
                key={h.terminalId}
                session={s}
                x={h.x}
                place={h.place}
                width={width}
                chore={choreFor(s.terminalId, now)}
                selected={selected === s.terminalId}
                onClick={() => host.focusSession(s.terminalId)}
              />
            )
          })}
          {departing.map((d) => (
            <CampHiker key={`gone:${d.session.terminalId}`} session={d.session} x={d.x} startX={d.from} place="tent" width={width} chore="map" selected={false} leaving />
          ))}
          {sessions.length === 0 && <span className="cs-empty">No one&apos;s at camp yet</span>}
        </>
      )}
    </div>
  )
}

/** A closed session's hiker, walking off to the nearer edge for WALK_MS */
interface Departure {
  session: PluginSession
  /** Where it stood */
  from: number
  /** The edge it walks to */
  x: number
}

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
    const gone = [...last.current.values()].filter((p) => !byId.has(p.session.terminalId)).map((p) => ({ session: p.session, from: p.x, x: offstage(p.x, width) }))
    last.current = current
    if (gone.length === 0) return
    setDeparting((d) => [...d, ...gone])
    const timer = setTimeout(() => {
      timers.current.delete(timer)
      setDeparting((d) => d.filter((x) => !gone.includes(x)))
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

/** While `open`, a press outside any tent or Escape calls `close` */
function useCloseOnOutside(open: boolean, close: () => void): void {
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent): void => {
      if (!(e.target instanceof Element) || !e.target.closest('.cs-tent')) close()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close()
    }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, close])
}
