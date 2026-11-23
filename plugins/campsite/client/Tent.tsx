// A worktree's tent at the campsite strip: its branch on a sign across the peak (Pixi draws the tent),
// and Global's log. Grouped (a crowded camp), each carries a badge (name, count, who is waiting)
// that opens a list of its sessions (TentPopover, drawn beside the tents so it sits over the app,
// not inside the tent's stacking context).
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { usePluginHost, type PluginSession } from '../../../src/shared/plugins/client.ts'
import { LOG_W, TENT_W, campTone, popoverLeft, signText, tentBadge, type CampTent, type FireSide } from '../shared/layout.ts'
import { SIGN_TEXT, choreFor, hikerLabel, stanceFor, statusText } from '../shared/pose.ts'
import { Hiker } from './Hiker.tsx'
import { useHikerLook } from './hooks.ts'

interface Props {
  tent: CampTent
  grouped: boolean
  open: boolean
  /** The badge was clicked */
  onToggle: (badge: HTMLButtonElement) => void
}

export function Tent({ tent, grouped, open, onToggle }: Props): React.JSX.Element {
  return (
    <div className="cs-tent" style={{ left: tent.x - TENT_W / 2, width: TENT_W }}>
      {grouped ? (
        <CampBadge camp={tent} name={signText(tent.name)} title={tent.name} open={open} onToggle={onToggle} />
      ) : (
        <span className="cs-tent-sign" title={tent.name}>
          {signText(tent.name)}
        </span>
      )}
    </div>
  )
}

type Camp = Pick<CampTent, 'hikers' | 'waiting' | 'deciding'>

/** Global's log; grouped, it carries a badge like a tent's */
export function CampLog({ log, grouped, open, onToggle }: { log: Camp & { x: number }; grouped: boolean; open: boolean; onToggle: (badge: HTMLButtonElement) => void }): React.JSX.Element {
  return (
    <div className="cs-log" style={{ left: log.x - LOG_W / 2, width: LOG_W }}>
      {grouped && <CampBadge camp={log} name="Global" title="Global" open={open} onToggle={onToggle} />}
    </div>
  )
}

function CampBadge({ camp, name, title, open, onToggle }: { camp: Camp; name: string; title: string; open: boolean; onToggle: (badge: HTMLButtonElement) => void }): React.JSX.Element {
  const tone = campTone(camp)
  return (
    // Narrower than the tents' pitch: the name is cut to fit, the count and the "!" or "?" never are
    <button className={`cs-camp-badge${tone ? ` ${tone}` : ''}`} onClick={(e) => onToggle(e.currentTarget)} aria-expanded={open} aria-label={`${title}, ${tentBadge(camp)}`} title={`Who's at ${title}: ${tentBadge(camp)}`}>
      <span className="cs-badge-name">{name}</span>
      <span>· {camp.hikers}</span>
      {tone && <b>{SIGN_TEXT[tone]}</b>}
    </button>
  )
}

/** The open camp: its worktree (null: Global's log), where its badge is (window coordinates) and its side of the fire */
export interface OpenTent {
  worktreeId: string | null
  /** The badge's left and right edges */
  left: number
  right: number
  /** The badge's top; the popover sits just above */
  top: number
  side: FireSide
}

interface PopoverProps {
  at: OpenTent
  name: string
  members: readonly PluginSession[]
  /** The chores' clock (ms) */
  now: number
  onPick: (terminalId: string) => void
}

export function TentPopover({ at, name, members, now, onPick }: PopoverProps): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [left, setLeft] = useState(at.left)
  // Away from the fire and inside the window, once its width is known (before paint). Every render:
  // a row's status can widen it, and a left camp's list must not grow back over the fire.
  useLayoutEffect(() => {
    const el = ref.current
    if (el) setLeft(popoverLeft(at, at.side, el.offsetWidth, window.innerWidth))
  })
  // Keyboard users land in the list
  useEffect(() => {
    ref.current?.querySelector('button')?.focus()
  }, [])
  return (
    <div ref={ref} className="cs-tent-popover" role="group" aria-label={`Sessions at ${name}`} style={{ left, top: at.top - 4 }}>
      {members.map((s) => (
        <PopoverRow key={s.terminalId} session={s} now={now} onPick={onPick} />
      ))}
    </div>
  )
}

function PopoverRow({ session, now, onPick }: { session: PluginSession; now: number; onPick: (terminalId: string) => void }): React.JSX.Element {
  const look = useHikerLook(usePluginHost(), session.terminalId, session.provider)
  const stance = stanceFor(session, choreFor(session.terminalId, now))
  return (
    <button onClick={() => onPick(session.terminalId)}>
      <Hiker look={look} pose={stance.pose} gear={stance.gear} grey={stance.grey} scale={1} label={hikerLabel(session)} decorative />
      <span className="cs-row-name">{session.label}</span>
      <span className={`cs-row-status${stance.sign ? ` ${stance.sign}` : ''}`}>{statusText(session)}</span>
    </button>
  )
}
