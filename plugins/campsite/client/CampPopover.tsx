// The camp's popover (campsite parts 3a, 3b, 3c, 3d-2 and 5), opened from the header's counts, a building on
// the strip, (at the Trails tab) a flag, the cairn or the signpost, (at the Guide tab) an animal, or
// (at the Camp tab's Noticeboard, focused) the noticeboard. Camp: the Noticeboard (part 5: the
// agents' notes; not from an older server), then each building's next
// tier with its effect and price, and Build when the camp can pay. Crew: the members (level, XP,
// where they are, their gear's bonus), each a button that opens its view (MemberView: pin, gear,
// journal; Back, or Escape, returns the focus to its row; another tab closes it), and today's
// walk-ins to hire. Trails: the trails and their history (TrailsTab). Guide: the field guide's 24
// species (GuideTab). DOM, fixed to the window above what opened it;
// Escape (focus back to the opener) or a press outside closes it. A refusal shows on its row for 4 s
// (the store has already reloaded); one for a walk-in who is gone shows under the walk-ins' heading.
// One purchase at a time; a building's row takes the focus once it is built or refused.
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { PluginSession } from '../../../src/shared/plugins/client.ts'
import { iconArt } from '../shared/buildingPixels.ts'
import type { CampSnapshot, CrewEntry } from '../shared/camp.ts'
import { crewLine, guideTab, hireState, memberStatus, memberSummary, projectNoteAt, shopRow, xpProgress, type HireState } from '../shared/campView.ts'
import { CATALOG, type BuildingId } from '../shared/catalog.ts'
import { memberLook } from '../shared/crew.ts'
import { kitKey, kitOf, withKit } from '../shared/hiker.ts'
import type { Candidate } from '../shared/shop.ts'
import type { CampStore, NotesState } from './campStore.ts'
import { GuideTab } from './GuideTab.tsx'
import { Hiker } from './Hiker.tsx'
import { MemberView } from './MemberView.tsx'
import { Noticeboard } from './Noticeboard.tsx'
import { TrailsTab } from './TrailsTab.tsx'

export type CampTab = 'camp' | 'crew' | 'trails' | 'guide'
const TABS: readonly CampTab[] = ['camp', 'crew', 'trails', 'guide']

/** Where the popover opens (its opener's left and top, window px), the building row to show (null: the top), and the tab (default Camp) and trail (a worktree's id, in the Trails tab) or species (in the Guide tab) */
export interface OpenCamp {
  left: number
  top: number
  focus: BuildingId | null
  tab?: CampTab
  trail?: string
  /** A species to show in the Guide tab (an animal on the strip was clicked) */
  species?: string
  /** What opened it, when more than one opener shares a tab ("signpost", "flag:<worktree>", "more:<stage>", "cairn", "animal", "board"): another one moves the popover rather than closing it; "board" focuses the Noticeboard */
  opener?: string
}

const EDGE = 8
const ERROR_MS = 4000

interface Props {
  camp: CampSnapshot
  at: OpenCamp
  sessions: readonly PluginSession[]
  /** The window's project (its trails come first) */
  projectId: string
  store: Pick<CampStore, 'build' | 'recruit' | 'gear' | 'pin' | 'journal' | 'trailLog' | 'loadNotes'>
  /** When the Guide tab was last opened (the prefs' guideSeenAt), and that it is opened now */
  guideSeenAt: number
  onGuideSeen: () => void
  /** The window's project's notes (part 5), and that the Noticeboard shows them now */
  notes: NotesState
  onNotesSeen: () => void
  onClose: (refocus: boolean) => void
}

export function CampPopover({ camp, at, sessions, projectId, store, guideSeenAt, onGuideSeen, notes, onNotesSeen, onClose }: Props): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [tab, setTab] = useState<CampTab>(at.tab ?? 'camp')
  const [left, setLeft] = useState(at.left)
  const [busy, setBusy] = useState(false)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>())
  // Unmounted: no more timers or state; a purchase in flight: no second one (a double click)
  const alive = useRef(true)
  const inFlight = useRef(false)
  const ids = useId()
  const tabId = (t: CampTab): string => `${ids}-tab-${t}`
  const panelId = (t: CampTab): string => `${ids}-panel-${t}`
  const labels = useMemo(() => new Map(sessions.map((s) => [s.terminalId, s.label])), [sessions])
  // The member whose view is open in the Crew tab (null: the list); the row to focus once it closes
  const [open, setOpen] = useState<string | null>(null)
  const backTo = useRef<string | null>(null)
  /** Back to the crew list, the member's row to take the focus */
  const closeMember = (id: string): void => {
    backTo.current = id
    setOpen(null)
  }
  // Escape in a member's view goes back to the list first (the document listener reads it here)
  const openRef = useRef<string | null>(null)
  openRef.current = tab === 'crew' ? open : null
  const closeMemberRef = useRef(closeMember)
  closeMemberRef.current = closeMember
  /** Another tab: a member's view is left (the Crew tab opens on its list, with no focus taken) */
  const switchTab = (t: CampTab): void => {
    if (t === tab) return
    setTab(t)
    setOpen(null)
  }
  useEffect(() => {
    if (open !== null || backTo.current === null) return
    ref.current?.querySelector<HTMLElement>(`[data-crew="${backTo.current}"]`)?.focus()
    backTo.current = null
  }, [open])

  // Inside the window once its width is known (before paint)
  useLayoutEffect(() => {
    const el = ref.current
    if (el) setLeft(Math.max(EDGE, Math.min(at.left, window.innerWidth - el.offsetWidth - EDGE)))
  })
  // Opened from a building: its row; from the noticeboard: the Noticeboard; at a trail or a species: its tab focuses its row or card; else the open tab. (Campsite keys the popover by where it opens.)
  useEffect(() => {
    const el = ref.current
    if (!el || at.trail !== undefined || at.species !== undefined) return
    const row = at.focus ? el.querySelector<HTMLElement>(`[data-building="${at.focus}"]`) : at.opener === 'board' ? el.querySelector<HTMLElement>('[data-noticeboard]') : null
    if (row) {
      row.scrollIntoView({ block: 'nearest' })
      row.focus()
    } else el.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus()
  }, [])
  useEffect(() => {
    const onDown = (e: PointerEvent): void => {
      if (!(e.target instanceof Element) || !e.target.closest('.cs-camp-popover, .cs-camp-button, .cs-building, .cs-flag, .cs-flag-more, .cs-cairn, .cs-animal, .cs-board')) onClose(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      const member = openRef.current
      if (member !== null) {
        e.preventDefault()
        closeMemberRef.current(member)
      } else onClose(true)
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
    alive.current = true
    const pending = timers.current
    return () => {
      alive.current = false
      for (const t of pending) clearTimeout(t)
    }
  }, [])

  /** Runs a purchase (one at a time); `settle` once it succeeds or fails; a refusal's message shows under `key` for ERROR_MS */
  const act = (key: string, run: () => Promise<void>, settle?: () => void): void => {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    run()
      .catch((err: unknown) => {
        if (!alive.current) return
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
      .finally(() => {
        inFlight.current = false
        if (!alive.current) return
        setBusy(false)
        // After the busy state clears, so a re-enabled control can take the focus
        if (settle) setTimeout(() => alive.current && settle(), 0)
      })
  }
  /** After a build or a refusal: its row (the Build button may be gone) */
  const focusRow = (id: BuildingId): void => {
    ref.current?.querySelector<HTMLElement>(`[data-building="${id}"]`)?.focus()
  }
  /** Left and Right step through the tabs, round (focus follows) */
  const onTabKey = (e: React.KeyboardEvent): void => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    e.preventDefault()
    const next = TABS[(TABS.indexOf(tab) + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length]
    switchTab(next)
    document.getElementById(tabId(next))?.focus()
  }

  const hire = hireState(camp)
  const member = open === null ? undefined : camp.crew.find((m) => m.id === open)
  // Refusals for walk-ins no longer listed (hired elsewhere, or the day turned)
  const goneErrors = Object.keys(errors).filter((k) => k.startsWith('hire:') && !camp.candidates.some((c) => `hire:${c.name}` === k))
  return (
    <div ref={ref} className="cs-camp-popover" role="dialog" aria-label="The camp" style={{ left, top: at.top - 4 }}>
      <div className="cs-camp-tabs" role="tablist" aria-label="The camp" onKeyDown={onTabKey}>
        {TABS.map((t) => (
          <button
            key={t}
            id={tabId(t)}
            role="tab"
            aria-selected={tab === t}
            aria-controls={panelId(t)}
            tabIndex={tab === t ? 0 : -1}
            className={tab === t ? 'on' : ''}
            onClick={() => switchTab(t)}
          >
            {t === 'camp' ? 'Camp' : t === 'crew' ? `Crew ${camp.crew.length}/${camp.bunks}` : t === 'trails' ? 'Trails' : guideTab(camp)}
          </button>
        ))}
      </div>
      {tab === 'camp' ? (
        <div className="cs-shop" role="tabpanel" id={panelId('camp')} aria-labelledby={tabId('camp')}>
          {/* An older server has no noticeboard (no noteAt) */}
          {camp.noteAt !== undefined && (
            <>
              <Noticeboard notes={notes} onLoad={store.loadNotes} noteAt={projectNoteAt(camp.noteAt, projectId)} onSeen={onNotesSeen} />
              <div className="cs-crew-heading">Buildings</div>
            </>
          )}
          {CATALOG.map((b) => {
            const row = shopRow(camp, b.id)
            const offer = row.offer
            return (
              <div key={b.id} className="cs-shop-row" data-building={b.id} tabIndex={-1} role="group" aria-label={row.name}>
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
                      <button
                        className="cs-shop-build"
                        aria-label={`Build ${row.name}`}
                        disabled={busy}
                        onClick={() => act(b.id, () => store.build({ id: b.id, tier: offer.tier, cost: offer.cost }), () => focusRow(b.id))}
                      >
                        Build
                      </button>
                    )}
                  </>
                )}
              </div>
            )
          })}
        </div>
      ) : tab === 'trails' ? (
        <div role="tabpanel" id={panelId('trails')} aria-labelledby={tabId('trails')}>
          <TrailsTab camp={camp} projectId={projectId} store={store} focus={at.trail ?? null} />
        </div>
      ) : tab === 'guide' ? (
        <div role="tabpanel" id={panelId('guide')} aria-labelledby={tabId('guide')}>
          <GuideTab camp={camp} focus={at.species ?? null} since={guideSeenAt} onSeen={onGuideSeen} />
        </div>
      ) : (
        <div className="cs-crew" role="tabpanel" id={panelId('crew')} aria-labelledby={tabId('crew')}>
          {member ? (
            <MemberView
              key={member.id}
              camp={camp}
              member={member}
              status={memberStatus(camp, member.id, labels)}
              store={store}
              busy={busy}
              errors={errors}
              act={act}
              onBack={() => closeMember(member.id)}
            />
          ) : (
            <>
              {camp.crew.map((m) => (
                <CrewRow key={m.id} member={m} status={memberStatus(camp, m.id, labels)} onOpen={() => setOpen(m.id)} />
              ))}
              <div className="cs-crew-heading">Walk-ins today</div>
              {goneErrors.map((k) => (
                <div key={k} className="cs-shop-error cs-crew-gone" role="alert">
                  {errors[k]}
                </div>
              ))}
              {camp.candidates.length === 0 && <div className="cs-crew-empty">Nobody else came by today.</div>}
              {camp.candidates.map((c) => (
                <WalkIn key={c.name} candidate={c} cost={camp.recruitCost} hire={hire} busy={busy} error={errors[`hire:${c.name}`]} onHire={() => act(`hire:${c.name}`, () => store.recruit(c.name, camp.recruitCost))} />
              ))}
            </>
          )}
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

/** A member's row: a button that opens its view; its label says it all (the bar inside is drawn only) */
function CrewRow({ member, status, onOpen }: { member: CrewEntry; status: string; onOpen: () => void }): React.JSX.Element {
  const kit = kitKey(member.gear)
  const look = useMemo(() => withKit(memberLook(member.seed), kitOf(kit)), [member.seed, kit])
  const pct = Math.round(xpProgress(member) * 100)
  const line = crewLine(status, member.bonus)
  return (
    <button className="cs-crew-row cs-crew-member" data-crew={member.id} aria-label={memberSummary(member, line)} title={`${member.xp} / ${member.next} XP`} onClick={onOpen}>
      <Hiker look={look} pose="stand" scale={2} label={member.name} decorative />
      <span className="cs-crew-text">
        <span className="cs-crew-name">
          {member.name} <span className="cs-crew-level">Lv {member.level} {member.title}</span>
        </span>
        <span className="cs-xp" aria-hidden="true">
          <span style={{ width: `${pct}%` }} />
        </span>
        <span className="cs-crew-status">{line}</span>
      </span>
      <span className="cs-crew-open" aria-hidden="true">
        ›
      </span>
    </button>
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
      <button className="cs-shop-build" aria-label={`Hire ${candidate.name} for ${cost} wood`} disabled={busy || hire.disabled} title={hire.reason ?? undefined} onClick={onHire}>
        Hire · 🪵 {cost}
      </button>
    </div>
  )
}
