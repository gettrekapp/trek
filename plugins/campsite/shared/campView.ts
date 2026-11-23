// What the camp popover says (campsite part 3a): a building's row, whether a hire can be made, a
// member's status line, how far it is through its level, and a building's tooltip on the strip.
// Pure.
import type { CampSnapshot } from './camp.ts'
import { building, costLabel, type BuildingId, type Cost } from './catalog.ts'
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
