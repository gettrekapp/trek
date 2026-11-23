// The camp's shop (campsite part 3a): every building's tiers with their cost and effect, and the
// numbers behind the effects, bunks, hires, walk-ins and the away card. One table, tunable. Pure.

export const BUILDING_IDS = ['lights', 'fire', 'garden', 'lake', 'cabins'] as const
export type BuildingId = (typeof BUILDING_IDS)[number]

export interface Cost {
  wood: number
  markers: number
}
export interface TierDef {
  /** The tier's own name ("Fire ring II") */
  name: string
  /** What it does, for the popover's row */
  effect: string
  cost: Cost
}
export interface BuildingDef {
  id: BuildingId
  name: string
  /** A new camp's tier: the fire ring 1 (today's ring), the rest 0 (not built) */
  start: number
  /** tiers[n - 1] is tier n; the start tier's entry is never bought */
  tiers: readonly TierDef[]
}

const c = (wood: number, markers = 0): Cost => ({ wood, markers })

/** In the popover's order */
export const CATALOG: readonly BuildingDef[] = [
  { id: 'lights', name: 'String lights', start: 0, tiers: [{ name: 'String lights', effect: 'Lights glow over the camp', cost: c(25) }] },
  {
    id: 'fire',
    name: 'Fire ring',
    start: 1,
    tiers: [
      { name: 'Fire ring', effect: 'Warmth lifts working wood up to ×1.5', cost: c(0) },
      { name: 'Fire ring II', effect: 'Warmth lifts working wood up to ×1.75', cost: c(300) },
      { name: 'Fire ring III', effect: 'Warmth lifts working wood up to ×2', cost: c(900, 1) }
    ]
  },
  {
    id: 'garden',
    name: 'Garden',
    start: 0,
    tiers: [
      { name: 'Garden plot', effect: '+2 wood an hour, always', cost: c(150) },
      { name: 'Garden beds', effect: '+5 wood an hour, always', cost: c(600) }
    ]
  },
  {
    id: 'lake',
    name: 'Lake',
    start: 0,
    tiers: [
      { name: 'Lake', effect: 'Each resting crew member fishes 1 wood an hour', cost: c(500) },
      { name: 'Dock', effect: 'Each resting crew member fishes 2 wood an hour', cost: c(1200, 1) }
    ]
  },
  {
    id: 'cabins',
    name: 'Cabins',
    start: 0,
    tiers: [
      { name: 'Cabin', effect: '+3 bunks (6 in all)', cost: c(400, 1) },
      { name: 'Two cabins', effect: '+3 bunks (9 in all)', cost: c(1000, 2) },
      { name: 'Three cabins', effect: '+3 bunks (12 in all)', cost: c(2000, 2) }
    ]
  }
]

export const building = (id: BuildingId): BuildingDef => CATALOG.find((b) => b.id === id)!
export const isBuildingId = (x: unknown): x is BuildingId => typeof x === 'string' && (BUILDING_IDS as readonly string[]).includes(x)
/** A new camp's tiers */
export function startBuilt(): Record<BuildingId, number> {
  const out = {} as Record<BuildingId, number>
  for (const b of CATALOG) out[b.id] = b.start
  return out
}

/** The warmth factor's ceiling by fire tier (1–3) */
const FIRE_CEILING: readonly number[] = [1.5, 1.75, 2]
export const fireCeiling = (tier: number): number => FIRE_CEILING[Math.min(Math.max(tier, 1), FIRE_CEILING.length) - 1]
/** Wood an hour by garden tier */
export const GARDEN_PER_HOUR: readonly number[] = [0, 2, 5]
/** Wood an hour for each resting member, by lake tier */
export const FISH_PER_HOUR: readonly number[] = [0, 1, 2]

export const START_BUNKS = 3
export const BUNKS_PER_CABIN = 3
/** A hire's price for a crew of `size`: 200 for the fourth member, 50 more for each one after */
export const hireCost = (size: number): number => 200 + 50 * Math.max(0, size - 3)
export const CANDIDATES_PER_DAY = 3
/** Flavour only in 3a */
export const TRAITS: readonly string[] = [
  'Hums on the switchbacks',
  'Always first to the summit',
  'Never forgets the marshmallows',
  'Reads maps upside down',
  'Packs too many socks',
  'Knows every bird call',
  'Naps at every viewpoint',
  'Brews terrible coffee',
  'Tells long stories by the fire',
  'Can light a fire in the rain',
  'Collects interesting rocks',
  'Whistles while chopping wood',
  'Up before the sun',
  'Keeps a tidy tent',
  'Swears by wool',
  'Never lost, only exploring',
  'Shares the trail mix',
  'Sketches every ridge',
  'Talks to the camp dog',
  'Counts every step'
]

/** The away card is due once nobody has seen the camp for longer than this */
export const AWAY_DUE_MS = 4 * 3_600_000

/** "900 wood and 1 marker", for messages */
export function costWords(cost: Cost): string {
  const parts = [`${cost.wood} wood`]
  if (cost.markers > 0) parts.push(`${cost.markers} marker${cost.markers === 1 ? '' : 's'}`)
  return parts.join(' and ')
}

/** "🪵 900 · ⛳ 1", for the popover */
export const costLabel = (cost: Cost): string => (cost.markers > 0 ? `🪵 ${cost.wood} · ⛳ ${cost.markers}` : `🪵 ${cost.wood}`)
