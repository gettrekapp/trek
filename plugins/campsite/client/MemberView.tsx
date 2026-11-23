// A crew member's view in the camp popover's Crew tab (campsite part 3b): its portrait wearing its
// gear, its level and XP, the wood bonus its gear gives and where it is; what it goes out on (any
// session, or a session type or agent the camp has seen: chosen, then Set, so stepping through the
// choices commits nothing); its gear, each slot's next item with Buy or what it needs first; its
// journal, newest first, asked for while the view is open (the snapshot doesn't carry it) and again
// when the member's XP, gear, pin or journal count changes. Back (focused on opening) returns to the
// list.
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { CampSnapshot, CrewEntry } from '../shared/camp.ts'
import { bonusText, gearRows, pinFrom, pinOptions, pinValue, xpProgress } from '../shared/campView.ts'
import { memberLook } from '../shared/crew.ts'
import { kitKey, kitOf, withKit } from '../shared/hiker.ts'
import { journalLines, type JournalEntry } from '../shared/journal.ts'
import type { CampStore } from './campStore.ts'
import { Hiker } from './Hiker.tsx'
import { useNow } from './hooks.ts'

interface Props {
  camp: CampSnapshot
  member: CrewEntry
  /** Where it is now ("with Claude 2", "fishing") */
  status: string
  store: Pick<CampStore, 'gear' | 'pin' | 'journal'>
  busy: boolean
  /** Refusals by key (`pin:<crewId>`, `gear:<crewId>:<slot>`), shown for 4 s */
  errors: Readonly<Record<string, string>>
  /** The popover's one-at-a-time runner: `settle` once it succeeds or fails */
  act: (key: string, run: () => Promise<void>, settle?: () => void) => void
  onBack: () => void
}

export function MemberView({ camp, member, status, store, busy, errors, act, onBack }: Props): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const back = useRef<HTMLButtonElement>(null)
  const now = useNow()
  const pinId = useId()
  const select = useRef<HTMLSelectElement>(null)
  useEffect(() => {
    back.current?.focus()
  }, [])
  // The pin chosen in the select, set only by Set; back to the member's pin whenever that changes
  const current = pinValue(member.pin)
  const [draft, setDraft] = useState(current)
  useEffect(() => setDraft(current), [current])
  // The journal: asked for on opening, and again when anything that writes one changed (a trip
  // credits XP; gear and pins are noted; a summit or a zero-wood trip moves the count or the newest time)
  const [journal, setJournal] = useState<JournalEntry[] | null>(null)
  const [journalFailed, setJournalFailed] = useState(false)
  const kit = kitKey(member.gear)
  useEffect(() => {
    let live = true
    store.journal(member.id).then(
      (entries) => {
        if (!live) return
        setJournal(entries)
        setJournalFailed(false)
      },
      () => {
        if (live) setJournalFailed(true)
      }
    )
    return () => {
      live = false
    }
  }, [store, member.id, member.xp, kit, current, member.journalCount, member.journalAt])
  const look = useMemo(() => withKit(memberLook(member.seed), kitOf(kit)), [member.seed, kit])
  const pct = Math.round(xpProgress(member) * 100)
  /** After a purchase or a refusal: the slot's row (its Buy may be gone) */
  const focusSlot = (slot: string): void => {
    ref.current?.querySelector<HTMLElement>(`[data-slot="${slot}"]`)?.focus()
  }
  const pinError = errors[`pin:${member.id}`]
  const lines = journal ? journalLines(journal, now) : []
  return (
    <div ref={ref} className="cs-member" data-crew-view={member.id}>
      <button ref={back} className="cs-member-back" aria-label="Back to the crew" onClick={onBack}>
        ‹ Crew
      </button>
      <div className="cs-member-head">
        <Hiker look={look} pose="stand" scale={3} label={member.name} decorative />
        <div className="cs-crew-text">
          <span className="cs-crew-name">
            {member.name} <span className="cs-crew-level">Lv {member.level} {member.title}</span>
          </span>
          <span
            className="cs-xp"
            title={`${member.xp} / ${member.next} XP`}
            role="progressbar"
            aria-label={`${member.name}'s XP to Lv ${member.level + 1}`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={pct}
            aria-valuetext={`${member.xp} / ${member.next} XP`}
          >
            <span style={{ width: `${pct}%` }} />
          </span>
          <span className="cs-member-bonus">{bonusText(member.bonus)}</span>
          <span className="cs-crew-status">{status}</span>
        </div>
      </div>
      <label className="cs-member-pin" htmlFor={pinId}>
        Goes out on
      </label>
      <div className="cs-member-pin-row">
        <select ref={select} id={pinId} className="cs-member-pin-select" value={draft} onChange={(e) => setDraft(e.target.value)}>
          {pinOptions(camp, member.pin).map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <button
          className="cs-shop-build cs-member-pin-set"
          aria-label="Set what it goes out on"
          disabled={busy || draft === current}
          onClick={() => {
            const pin = pinFrom(draft)
            act(`pin:${member.id}`, () => store.pin(member.id, pin), () => select.current?.focus())
          }}
        >
          Set
        </button>
      </div>
      {pinError && (
        <span className="cs-shop-error cs-member-pin-error" role="alert">
          {pinError}
        </span>
      )}
      <div className="cs-crew-heading">Gear</div>
      {gearRows(camp, member).map((row) => {
        const next = row.next
        const error = errors[`gear:${member.id}:${row.slot}`]
        return (
          <div key={row.slot} className="cs-gear-row" data-slot={row.slot} tabIndex={-1} role="group" aria-label={`${row.slotName}: ${row.current}`}>
            <span className="cs-gear-slot">{row.slotName}</span>
            <div className="cs-shop-text">
              <span className="cs-gear-current">{row.current}</span>
              {next && <span className="cs-shop-effect">Next: {next.name}</span>}
              {error && (
                <span className="cs-shop-error" role="alert">
                  {error}
                </span>
              )}
            </div>
            {next === null ? (
              <span className="cs-shop-built">Best there is</span>
            ) : (
              <>
                <span className="cs-shop-cost">{row.price}</span>
                {row.blocked ? (
                  <span className="cs-shop-short">{row.blocked}</span>
                ) : (
                  <button
                    className="cs-shop-build cs-gear-buy"
                    aria-label={`Buy ${next.name} for ${member.name}, ${next.cost} wood`}
                    disabled={busy}
                    onClick={() => act(`gear:${member.id}:${row.slot}`, () => store.gear(member.id, row.slot, next.tier, next.cost), () => focusSlot(row.slot))}
                  >
                    Buy
                  </button>
                )}
              </>
            )}
          </div>
        )
      })}
      <div className="cs-crew-heading">Journal</div>
      {journal === null ? (
        <div className="cs-crew-empty">{journalFailed ? 'The journal could not be read.' : 'Reading the journal…'}</div>
      ) : lines.length === 0 ? (
        <div className="cs-crew-empty">Nothing yet.</div>
      ) : (
        <ol className="cs-journal">
          {lines.map((l) => (
            <li key={l.key}>
              <span>{l.text}</span>
              <span className="cs-journal-when">{l.when}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}
