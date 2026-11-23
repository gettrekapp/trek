// What the camp popover says (campsite parts 3a and 3b): a building's row, whether a hire can be
// made, a member's status line, how far it is through its level, and a building's tooltip on the
// strip; a member's view: its gear rows, its bonus, and the pin's choices. Pure.
import type { CampSnapshot, CrewEntry, Pin } from './camp.ts'
import { GEAR_COST, GEAR_SLOTS, GEAR_TOP, SLOT_NAMES, building, costLabel, gearGate, gearItem, type BuildingId, type Cost, type GearSlot } from './catalog.ts'
import { levelXp } from './crew.ts'
import { shortfall } from './shop.ts'

export interface ShopRow {
  id: BuildingId
  /** The offered tier's name, or the top tier's once it is fully built */
  name: string
  /** "Tier 2 of 3" */
  tier: string
  effect: string
  /** The tier on offer; null: fully built */
  offer: { tier: number; cost: Cost } | null
  /** "🪵 300 · ⛳ 1" ('' when fully built) */
  price: string
  /** Why it can't be built now ("Need 120 more wood"); null when it can, or when it is built */
  short: string | null
}

export function shopRow(snap: Pick<CampSnapshot, 'wood' | 'markers' | 'built' | 'offers'>, id: BuildingId): ShopRow {
  const def = building(id)
  const offer = snap.offers.find((o) => o.id === id)
  const n = offer ? offer.tier : snap.built[id]
  const t = def.tiers[n - 1]
  return {
    id,
    name: t.name,
    tier: `Tier ${n} of ${def.tiers.length}`,
    effect: t.effect,
    offer: offer ? { tier: offer.tier, cost: offer.cost } : null,
    price: offer ? costLabel(offer.cost) : '',
    short: offer ? shortfall(snap, offer.cost) : null
  }
}

export interface HireState {
  disabled: boolean
  /** Why not: no free bunk, or wood short */
  reason: string | null
}

export function hireState(snap: Pick<CampSnapshot, 'wood' | 'crew' | 'bunks' | 'recruitCost'>): HireState {
  if (snap.crew.length >= snap.bunks) return { disabled: true, reason: 'No free bunk: build a cabin first' }
  const short = shortfall({ wood: snap.wood, markers: 0 }, { wood: snap.recruitCost, markers: 0 })
  return short ? { disabled: true, reason: short } : { disabled: false, reason: null }
}

/** "with <session label>" (a session in this window's project), "out on another project", "fishing" (with the lake) or "resting" */
export function memberStatus(snap: Pick<CampSnapshot, 'assignments' | 'built'>, crewId: string, labels: ReadonlyMap<string, string>): string {
  const terminalId = Object.keys(snap.assignments).find((id) => snap.assignments[id] === crewId)
  if (terminalId !== undefined) {
    const label = labels.get(terminalId)
    return label === undefined ? 'out on another project' : `with ${label}`
  }
  return snap.built.lake >= 1 ? 'fishing' : 'resting'
}

/** How far a member is through its level, 0–1 (its XP bar) */
export function xpProgress(m: { level: number; xp: number; next: number }): number {
  const start = levelXp(m.level)
  return m.next > start ? Math.min(1, Math.max(0, (m.xp - start) / (m.next - start))) : 1
}

/** A building's tooltip on the strip: "Two cabins (tier 2 of 3)" */
export function placedTitle(p: { id: BuildingId; tier: number }): string {
  const def = building(p.id)
  return `${def.tiers[p.tier - 1].name} (tier ${p.tier} of ${def.tiers.length})`
}

/** A member's row in the crew list, for its button's label: "Aspen, Lv 2 Trailblazer, 150 / 400 XP, resting" */
export const memberSummary = (m: Pick<CrewEntry, 'name' | 'level' | 'title' | 'xp' | 'next'>, status: string): string => `${m.name}, Lv ${m.level} ${m.title}, ${m.xp} / ${m.next} XP, ${status}`

/** "+6% wood" */
export const bonusText = (bonus: number): string => `+${bonus}% wood`

export interface GearRow {
  slot: GearSlot
  /** "Pack" */
  slotName: string
  /** The item worn ("Forest pack"), or "None" */
  current: string
  /** The slot's next tier; null: it has the best there is */
  next: { tier: number; name: string; cost: number } | null
  /** "🪵 200" ('' with nothing next) */
  price: string
  /** Why it can't be bought now: the shed or the level ("Needs Lv 3"), else the wood ("Need 40 more wood"); null when it can */
  blocked: string | null
}

/** A member's four gear rows: what it wears, the next item and its price, or what it needs first */
export function gearRows(snap: Pick<CampSnapshot, 'wood' | 'built'>, member: Pick<CrewEntry, 'gear' | 'level'>): GearRow[] {
  return GEAR_SLOTS.map((slot) => {
    const tier = member.gear[slot]
    const current = tier > 0 ? gearItem(slot, tier).name : 'None'
    if (tier >= GEAR_TOP) return { slot, slotName: SLOT_NAMES[slot], current, next: null, price: '', blocked: null }
    const n = tier + 1
    const cost = GEAR_COST[n - 1]
    const blocked = gearGate(snap.built.shed, member.level, n) ?? shortfall({ wood: snap.wood, markers: 0 }, { wood: cost, markers: 0 })
    return { slot, slotName: SLOT_NAMES[slot], current, next: { tier: n, name: gearItem(slot, n).name, cost }, price: costLabel({ wood: cost, markers: 0 }), blocked }
  })
}

/** A pin as a select's value: '' (any session), "type:<id>" or "provider:<id>" (a type's id is its typeKey, "<project id>:<type id>") */
export const pinValue = (pin: Pin | null): string => (pin ? `${pin.kind}:${pin.id}` : '')

/** The pin a select's value names (split at its first colon: the id may hold more); null for '' (or anything else) */
export function pinFrom(value: string): Pin | null {
  const at = value.indexOf(':')
  const kind = value.slice(0, at)
  const id = value.slice(at + 1)
  return at > 0 && id !== '' && (kind === 'type' || kind === 'provider') ? { kind, id } : null
}

/**
 * The pin's choices: any session, then each session type and agent seen in the last 30 days; a type
 * whose name another seen type shares says its project (the snapshot names no projects, so its
 * id: the typeKey's part before the colon); a current pin no longer seen stays listed (by its id)
 */
export function pinOptions(snap: Pick<CampSnapshot, 'seenKinds'>, current: Pin | null): { value: string; label: string }[] {
  const label = (kind: Pin['kind'], name: string): string => `${kind === 'type' ? 'Session type' : 'Agent'}: ${name}`
  const types = snap.seenKinds.filter((k) => k.kind === 'type')
  const shared = (k: { id: string; name: string }): boolean => types.some((o) => o.id !== k.id && o.name === k.name)
  const project = (id: string): string => id.slice(0, Math.max(0, id.indexOf(':')))
  const named = (k: CampSnapshot['seenKinds'][number]): string => (k.kind === 'type' && shared(k) ? `${k.name} (${project(k.id)})` : k.name)
  const out = [{ value: '', label: 'Any session' }, ...snap.seenKinds.map((k) => ({ value: pinValue(k), label: label(k.kind, named(k)) }))]
  if (current && !out.some((o) => o.value === pinValue(current))) out.push({ value: pinValue(current), label: label(current.kind, current.id) })
  return out
}
