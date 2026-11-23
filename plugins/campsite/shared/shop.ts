// The camp's shop (campsite part 3a): a building's next tier, and one of the day's three walk-ins
// hired into a free bunk. `build` and `recruit` check what a window sent against the catalog and the
// camp, then change the camp in place (null) or say why not (a refusal the server half throws).
// Purchases are final. Pure: the caller passes the time.
import type { Camp, CrewMember } from './camp.ts'
import { BUNKS_PER_CABIN, CANDIDATES_PER_DAY, CATALOG, START_BUNKS, TRAITS, building, costWords, hireCost, isBuildingId, type BuildingId, type Cost } from './catalog.ts'
import { TRAIL_NAMES } from './crew.ts'
import { fnv1a } from './hiker.ts'

/** A building's next tier, at its price */
export interface Offer {
  id: BuildingId
  tier: number
  cost: Cost
}
/** A walk-in: a trail name, a look's seed, a trait line */
export interface Candidate {
  name: string
  seed: number
  trait: string
}
export interface ShopRefusal {
  code: 'BAD_REQUEST' | 'CONFLICT'
  message: string
}

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x)
const amount = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x >= 0
const bad = (message: string): ShopRefusal => ({ code: 'BAD_REQUEST', message })
const conflict = (message: string): ShopRefusal => ({ code: 'CONFLICT', message })

/** Each building's next tier, in the catalog's order; none for one that is fully built */
export function offers(camp: Pick<Camp, 'built'>): Offer[] {
  const out: Offer[] = []
  for (const b of CATALOG) {
    const tier = camp.built[b.id] + 1
    if (tier <= b.tiers.length) out.push({ id: b.id, tier, cost: { ...b.tiers[tier - 1].cost } })
  }
  return out
}

export const bunks = (camp: Pick<Camp, 'built'>): number => START_BUNKS + BUNKS_PER_CABIN * camp.built.cabins

/** "Need 120 more wood", "Need 1 more marker", both joined by "and"; null when `have` covers it (wood counted whole) */
export function shortfall(have: { wood: number; markers: number }, cost: Cost): string | null {
  const wood = cost.wood - Math.floor(have.wood)
  const markers = cost.markers - have.markers
  const parts: string[] = []
  if (wood > 0) parts.push(`${wood} more wood`)
  if (markers > 0) parts.push(`${markers} more marker${markers === 1 ? '' : 's'}`)
  return parts.length === 0 ? null : `Need ${parts.join(' and ')}`
}

/** The server's local date, YYYY-MM-DD */
export function dayOf(now: number): string {
  const d = new Date(now)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** The day's walk-ins for a camp's seed: trail names not `taken`, ordered by a hash of seed, day and name (so taking one out keeps the others' places) */
export function candidates(seed: number, day: string, taken: readonly string[]): Candidate[] {
  const skip = new Set(taken)
  return TRAIL_NAMES.filter((name) => !skip.has(name))
    .map((name) => ({ name, k: fnv1a(`${seed}:${day}:${name}`) }))
    .sort((a, b) => a.k - b.k || (a.name < b.name ? -1 : 1))
    .slice(0, CANDIDATES_PER_DAY)
    .map(({ name }) => ({ name, seed: fnv1a(`${seed}:${day}:look:${name}`), trait: TRAITS[fnv1a(`${seed}:${day}:trait:${name}`) % TRAITS.length] }))
}

/** Today's walk-ins less those hired today (who still count as walk-ins, not as taken, so the others keep their places) */
export function todaysCandidates(camp: Pick<Camp, 'seed' | 'crew' | 'hired'>, now: number): Candidate[] {
  const day = dayOf(now)
  const hiredToday = camp.hired.day === day ? camp.hired.names : []
  const taken = camp.crew.map((m) => m.name).filter((n) => !hiredToday.includes(n))
  return candidates(camp.seed, day, taken).filter((c) => !hiredToday.includes(c.name))
}

/** Builds `{ id, tier, cost: { wood, markers } }`: the building's next tier at the catalog's price, if the camp can pay */
export function build(camp: Camp, params: Record<string, unknown>): ShopRefusal | null {
  const { id, tier, cost } = params
  if (!isBuildingId(id)) return bad(`Unknown building: ${String(id)}`)
  if (!Number.isInteger(tier) || !isRecord(cost) || !amount(cost.wood) || !amount(cost.markers)) return bad('A build needs { id, tier, cost: { wood, markers } }')
  const def = building(id)
  const next = camp.built[id] + 1
  if (next > def.tiers.length) return conflict(`${def.name} is fully built`)
  if (tier !== next) return conflict(`${def.name}'s next tier is ${next}, not ${String(tier)}`)
  const want = def.tiers[next - 1]
  if (cost.wood !== want.cost.wood || cost.markers !== want.cost.markers) return conflict(`The price changed: ${want.name} costs ${costWords(want.cost)}`)
  const short = shortfall(camp, want.cost)
  if (short) return conflict(short)
  camp.wood -= want.cost.wood
  camp.markers -= want.cost.markers
  camp.built[id] = next
  return null
}

/** Hires `{ candidate, cost: { wood } }`: one of today's walk-ins, into a free bunk, at the current price */
export function recruit(camp: Camp, params: Record<string, unknown>, now: number): ShopRefusal | null {
  const { candidate, cost } = params
  if (typeof candidate !== 'string' || !isRecord(cost) || !amount(cost.wood)) return bad('A hire needs { candidate, cost: { wood } }')
  const walkIn = todaysCandidates(camp, now).find((c) => c.name === candidate)
  if (!walkIn) return conflict(`${candidate} isn't at camp today`)
  if (camp.crew.length >= bunks(camp)) return conflict('No free bunk: build a cabin first')
  const price = hireCost(camp.crew.length)
  if (cost.wood !== price) return conflict(`The price changed: a hire costs ${price} wood`)
  const short = shortfall(camp, { wood: price, markers: 0 })
  if (short) return conflict(short)
  camp.wood -= price
  camp.crew.push({ id: nextCrewId(camp.crew), name: walkIn.name, seed: walkIn.seed, xp: 0, restedAt: now })
  const day = dayOf(now)
  if (camp.hired.day !== day) camp.hired = { day, names: [] }
  camp.hired.names.push(walkIn.name)
  return null
}

function nextCrewId(crew: readonly CrewMember[]): string {
  let max = 0
  for (const m of crew) {
    const n = /^c(\d+)$/.exec(m.id)
    if (n) max = Math.max(max, Number(n[1]))
  }
  return `c${max + 1}`
}
