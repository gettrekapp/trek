// A crew member's view in the camp popover's Crew tab (campsite part 3b): its portrait wearing its
// gear, its level and XP, the wood bonus its gear gives and where it is; what it goes out on (any
// session, or a session type or agent the camp has seen); its gear, each slot's next item with Buy
// or what it needs first; its journal, newest first. Back (focused on opening) returns to the list.
import { useEffect, useId, useMemo, useRef } from 'react'
import type { CampSnapshot, CrewEntry } from '../shared/camp.ts'
import { bonusText, gearRows, pinFrom, pinOptions, pinValue, xpProgress } from '../shared/campView.ts'
import { memberLook } from '../shared/crew.ts'
import { kitKey, kitOf, withKit } from '../shared/hiker.ts'
import { journalLines } from '../shared/journal.ts'
import type { CampStore } from './campStore.ts'
import { Hiker } from './Hiker.tsx'
import { useNow } from './hooks.ts'

interface Props {
  camp: CampSnapshot
  member: CrewEntry
  /** Where it is now ("with Claude 2", "fishing") */
  status: string
  store: Pick<CampStore, 'gear' | 'pin'>
  busy: boolean
  /** Refusals by key (`pin:<crewId>`, `gear:<crewId>:<slot>`), shown for 4 s */
  errors: Readonly<Record<string, string>>
  /** The popover's one-at-a-time runner: `done` after it succeeds */
  act: (key: string, run: () => Promise<void>, done?: () => void) => void
  onBack: () => void
}

export function MemberView({ camp, member, status, store, busy, errors, act, onBack }: Props): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const back = useRef<HTMLButtonElement>(null)
  const now = useNow()
  const pinId = useId()
  useEffect(() => {
    back.current?.focus()
  }, [])
  const kit = kitKey(member.gear)
  const look = useMemo(() => withKit(memberLook(member.seed), kitOf(kit)), [member.seed, kit])
  const pct = Math.round(xpProgress(member) * 100)
  /** After a purchase: the slot's row (its Buy may be gone) */
  const focusSlot = (slot: string): void => {
    ref.current?.querySelector<HTMLElement>(`[data-slot="${slot}"]`)?.focus()
  }
  const pinError = errors[`pin:${member.id}`]
  const lines = journalLines(member.journal, now)
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
      <select
        id={pinId}
        className="cs-member-pin-select"
        value={pinValue(member.pin)}
        disabled={busy}
        onChange={(e) => {
          const pin = pinFrom(e.target.value)
          act(`pin:${member.id}`, () => store.pin(member.id, pin))
        }}
      >
        {pinOptions(camp, member.pin).map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
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
      {lines.length === 0 ? (
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
