// The camp's popover (campsite part 3a), opened from the header's counts or a building on the
// strip. Camp: each building's next tier with its effect and price, and Build when the camp can
// pay. Crew: the members (level, XP, where they are) and today's walk-ins to hire. DOM, fixed to
// the window above what opened it; Escape (focus back to the opener) or a press outside closes it.
// A refusal shows on its row for 4 s (the store has already reloaded).
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { PluginSession } from '../../../src/shared/plugins/client.ts'
import { iconArt } from '../shared/buildingPixels.ts'
import type { CampSnapshot, CrewEntry } from '../shared/camp.ts'
import { hireState, memberStatus, shopRow, xpProgress, type HireState } from '../shared/campView.ts'
import { CATALOG, type BuildingId } from '../shared/catalog.ts'
import { memberLook } from '../shared/crew.ts'
import type { Candidate } from '../shared/shop.ts'
import type { CampStore } from './campStore.ts'
import { Hiker } from './Hiker.tsx'

/** Where the popover opens (its opener's left and top, window px) and the building row to show (null: the top) */
export interface OpenCamp {
  left: number
  top: number
  focus: BuildingId | null
}

const EDGE = 8
const ERROR_MS = 4000

interface Props {
  camp: CampSnapshot
  at: OpenCamp
  sessions: readonly PluginSession[]
  store: Pick<CampStore, 'build' | 'recruit'>
  onClose: (refocus: boolean) => void
}

export function CampPopover({ camp, at, sessions, store, onClose }: Props): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [tab, setTab] = useState<'camp' | 'crew'>('camp')
  const [left, setLeft] = useState(at.left)
  const [busy, setBusy] = useState(false)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>())
  const labels = useMemo(() => new Map(sessions.map((s) => [s.terminalId, s.label])), [sessions])

  // Inside the window once its width is known (before paint)
  useLayoutEffect(() => {
    const el = ref.current
    if (el) setLeft(Math.max(EDGE, Math.min(at.left, window.innerWidth - el.offsetWidth - EDGE)))
  })
  // Opened from a building: its row; else the tabs. (Campsite keys the popover by `at.focus`.)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const row = at.focus ? el.querySelector<HTMLElement>(`[data-building="${at.focus}"]`) : null
    if (row) {
      row.scrollIntoView({ block: 'nearest' })
      row.focus()
    } else el.querySelector<HTMLElement>('[role="tab"]')?.focus()
  }, [])
  useEffect(() => {
    const onDown = (e: PointerEvent): void => {
      if (!(e.target instanceof Element) || !e.target.closest('.cs-camp-popover, .cs-camp-button, .cs-building')) onClose(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose(true)
    }
    const onResize = (): void => onClose(false)
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    window.addEventListener('resize', onResize)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', onResize)
    }
  }, [onClose])
  useEffect(() => {
    const pending = timers.current
    return () => {
      for (const t of pending) clearTimeout(t)
    }
  }, [])

  /** Runs a purchase; a refusal's message shows under `key` for ERROR_MS */
  const act = (key: string, run: () => Promise<void>): void => {
    setBusy(true)
    run()
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        setErrors((e) => ({ ...e, [key]: message }))
        const timer = setTimeout(() => {
          timers.current.delete(timer)
          setErrors((e) => {
            const next = { ...e }
            delete next[key]
            return next
          })
        }, ERROR_MS)
        timers.current.add(timer)
      })
      .finally(() => setBusy(false))
  }

  const hire = hireState(camp)
  return (
    <div ref={ref} className="cs-camp-popover" role="dialog" aria-label="The camp" style={{ left, top: at.top - 4 }}>
      <div className="cs-camp-tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'camp'} className={tab === 'camp' ? 'on' : ''} onClick={() => setTab('camp')}>
          Camp
        </button>
        <button role="tab" aria-selected={tab === 'crew'} className={tab === 'crew' ? 'on' : ''} onClick={() => setTab('crew')}>
          Crew {camp.crew.length}/{camp.bunks}
        </button>
      </div>
      {tab === 'camp' ? (
        <div className="cs-shop" role="tabpanel">
          {CATALOG.map((b) => {
            const row = shopRow(camp, b.id)
            const offer = row.offer
            return (
              <div key={b.id} className="cs-shop-row" data-building={b.id} tabIndex={-1}>
                <BuildingIcon id={b.id} tier={offer?.tier ?? camp.built[b.id]} />
                <div className="cs-shop-text">
                  <span className="cs-shop-name">
                    {row.name} <span className="cs-shop-tier">{row.tier}</span>
                  </span>
                  <span className="cs-shop-effect">{row.effect}</span>
                  {errors[b.id] && (
                    <span className="cs-shop-error" role="alert">
                      {errors[b.id]}
                    </span>
                  )}
                </div>
                {offer === null ? (
                  <span className="cs-shop-built">Built</span>
                ) : (
                  <>
                    <span className="cs-shop-cost">{row.price}</span>
                    {row.short ? (
                      <span className="cs-shop-short">{row.short}</span>
                    ) : (
                      <button className="cs-shop-build" disabled={busy} onClick={() => act(b.id, () => store.build({ id: b.id, tier: offer.tier, cost: offer.cost }))}>
                        Build
                      </button>
                    )}
                  </>
                )}
              </div>
            )
          })}
        </div>
      ) : (
        <div className="cs-crew" role="tabpanel">
          {camp.crew.map((m) => (
            <CrewRow key={m.id} member={m} status={memberStatus(camp, m.id, labels)} />
          ))}
          <div className="cs-crew-heading">Walk-ins today</div>
          {camp.candidates.length === 0 && <div className="cs-crew-empty">Nobody else came by today.</div>}
          {camp.candidates.map((c) => (
            <WalkIn key={c.name} candidate={c} cost={camp.recruitCost} hire={hire} busy={busy} error={errors[`hire:${c.name}`]} onHire={() => act(`hire:${c.name}`, () => store.recruit(c.name, camp.recruitCost))} />
          ))}
        </div>
      )}
    </div>
  )
}

/** A building's icon, scaled whole into 40×24 */
function BuildingIcon({ id, tier }: { id: BuildingId; tier: number }): React.JSX.Element {
  const art = iconArt(id, Math.max(1, tier))
  const scale = Math.min(40 / art.w, 24 / art.h)
  return (
    <span className="cs-shop-icon" aria-hidden="true">
      <svg width={Math.round(art.w * scale)} height={Math.round(art.h * scale)} viewBox={`0 0 ${art.w} ${art.h}`} shapeRendering="crispEdges">
        {art.rects.map((r, i) => (
          <rect key={i} x={r.x} y={r.y} width={r.w} height={r.h} fill={r.fill} />
        ))}
      </svg>
    </span>
  )
}

function CrewRow({ member, status }: { member: CrewEntry; status: string }): React.JSX.Element {
  const look = useMemo(() => memberLook(member.seed), [member.seed])
  return (
    <div className="cs-crew-row">
      <Hiker look={look} pose="stand" scale={2} label={member.name} decorative />
      <div className="cs-crew-text">
        <span className="cs-crew-name">
          {member.name} <span className="cs-crew-level">Lv {member.level} {member.title}</span>
        </span>
        <span className="cs-xp" title={`${member.xp} / ${member.next} XP`}>
          <span style={{ width: `${Math.round(xpProgress(member) * 100)}%` }} />
        </span>
        <span className="cs-crew-status">{status}</span>
      </div>
    </div>
  )
}

interface WalkInProps {
  candidate: Candidate
  cost: number
  hire: HireState
  busy: boolean
  error: string | undefined
  onHire: () => void
}

function WalkIn({ candidate, cost, hire, busy, error, onHire }: WalkInProps): React.JSX.Element {
  const look = useMemo(() => memberLook(candidate.seed), [candidate.seed])
  return (
    <div className="cs-crew-row" data-candidate={candidate.name}>
      <Hiker look={look} pose="wave" scale={2} label={candidate.name} decorative />
      <div className="cs-crew-text">
        <span className="cs-crew-name">{candidate.name}</span>
        <span className="cs-crew-status">{candidate.trait}</span>
        {hire.reason && <span className="cs-shop-short">{hire.reason}</span>}
        {error && (
          <span className="cs-shop-error" role="alert">
            {error}
          </span>
        )}
      </div>
      <button className="cs-shop-build" disabled={busy || hire.disabled} title={hire.reason ?? undefined} onClick={onHire}>
        Hire · 🪵 {cost}
      </button>
    </div>
  )
}
