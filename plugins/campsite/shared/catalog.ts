// The camp's shop (campsite parts 3a, 3b, 3c and 3d-2): every building's tiers with their cost and effect, and
// the numbers behind the effects, bunks, hires, walk-ins and the away card; the crew's gear (four
// slots × three tiers: names, prices, the shed and level each tier needs, its wood bonus). One
// table, tunable. Pure.

export const HOUR_MS = 3_600_000
export const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x)

export const BUILDING_IDS = ['lights', 'fire', 'garden', 'lake', 'cabins', 'shed', 'signpost', 'tower'] as const
export type BuildingId = (typeof BUILDING_IDS)[number]

export interface Cost {
  readonly wood: number
  readonly markers: number
}
export interface TierDef {
  /** The tier's own name ("Fire ring II") */
  readonly name: string
  /** What it does, for the popover's row */
  readonly effect: string
  readonly cost: Cost
}
export interface BuildingDef {
  readonly id: BuildingId
  readonly name: string
  /** A new camp's tier: the fire ring 1 (today's ring), the rest 0 (not built) */
  readonly start: number
  /** tiers[n - 1] is tier n; the start tier's entry is never bought */
  readonly tiers: readonly TierDef[]
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
  },
  {
    id: 'shed',
    name: 'Gear shed',
    start: 0,
    tiers: [
      { name: 'Gear shed', effect: 'The crew can buy gear tiers 1 and 2', cost: c(250) },
      { name: 'Gear shed II', effect: 'The crew can buy gear tier 3', cost: c(800, 1) }
    ]
  },
  { id: 'signpost', name: 'Trail signpost', start: 0, tiers: [{ name: 'Trail signpost', effect: "See every project's trails", cost: c(150) }] },
  {
    id: 'tower',
    name: 'Ranger tower',
    start: 0,
    tiers: [
      { name: 'Ranger tower', effect: 'Rare animals can appear', cost: c(500, 2) },
      { name: 'Ranger tower II', effect: 'More sightings; hints for unseen animals', cost: c(1200, 3) }
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

/** The session types and agents the camp saw start a session within this long are offered for pinning */
export const SEEN_KIND_MS = 30 * 24 * HOUR_MS

/** The away card is due once nobody has seen the camp for longer than this */
export const AWAY_DUE_MS = 4 * HOUR_MS

/** "900 wood and 1 marker", for messages */
export function costWords(cost: Cost): string {
  const parts = [`${cost.wood} wood`]
  if (cost.markers > 0) parts.push(`${cost.markers} marker${cost.markers === 1 ? '' : 's'}`)
  return parts.join(' and ')
}

/** "🪵 900 · ⛳ 1", for the popover */
export const costLabel = (cost: Cost): string => (cost.markers > 0 ? `🪵 ${cost.wood} · ⛳ ${cost.markers}` : `🪵 ${cost.wood}`)

/** Wood (or a tally) as shown and checked: floored, forgiving the float drift of many small payments (30 × 2/60 is 0.9999999999999999) */
export const whole = (x: number): number => Math.floor(x + 1e-6)

export const GEAR_SLOTS = ['pack', 'boots', 'hat', 'tool'] as const
export type GearSlot = (typeof GEAR_SLOTS)[number]
/** A member's tier in each slot: 0 (none) to GEAR_TOP */
export type GearTiers = Record<GearSlot, number>
export const GEAR_TOP = 3
export const isGearSlot = (x: unknown): x is GearSlot => typeof x === 'string' && (GEAR_SLOTS as readonly string[]).includes(x)
/** No gear */
export function noGear(): GearTiers {
  const out = {} as GearTiers
  for (const slot of GEAR_SLOTS) out[slot] = 0
  return out
}

export interface GearItem {
  /** "Ice axe" */
  name: string
  /** "an ice axe", for the journal ("Bought an ice axe") */
  phrase: string
}
/** Each slot's items, by tier (GEAR[slot][n - 1] is tier n) */
export const GEAR: Readonly<Record<GearSlot, readonly GearItem[]>> = {
  pack: [
    { name: 'Canvas pack', phrase: 'a canvas pack' },
    { name: 'Forest pack', phrase: 'a forest pack' },
    { name: 'Crimson pack', phrase: 'a crimson pack' }
  ],
  boots: [
    { name: 'Leather boots', phrase: 'leather boots' },
    { name: 'Black boots', phrase: 'black boots' },
    { name: 'Red-laced boots', phrase: 'red-laced boots' }
  ],
  hat: [
    { name: 'Bucket hat', phrase: 'a bucket hat' },
    { name: 'Ranger hat', phrase: 'a ranger hat' },
    { name: 'Alpine hat', phrase: 'an alpine hat' }
  ],
  tool: [
    { name: 'Trekking pole', phrase: 'a trekking pole' },
    { name: 'Ice axe', phrase: 'an ice axe' },
    { name: 'Gold ice axe', phrase: 'a gold ice axe' }
  ]
}
export const SLOT_NAMES: Readonly<Record<GearSlot, string>> = { pack: 'Pack', boots: 'Boots', hat: 'Hat', tool: 'Tool' }
/** An item's price in wood, by tier (GEAR_COST[n - 1]) */
export const GEAR_COST: readonly number[] = [60, 200, 500]
/** An item's bonus (percent) on the wood its member's sessions earn, by tier */
export const GEAR_BONUS: readonly number[] = [2, 4, 6]
/** What a tier needs: the gear shed's tier and the member's level */
export const GEAR_NEEDS: readonly { shed: number; level: number }[] = [
  { shed: 1, level: 1 },
  { shed: 1, level: 3 },
  { shed: 2, level: 5 }
]
export const gearItem = (slot: GearSlot, tier: number): GearItem => GEAR[slot][tier - 1]
/** A member's bonus (percent): the sum of its items' */
export const gearBonus = (gear: Readonly<GearTiers>): number => GEAR_SLOTS.reduce((sum, slot) => sum + (gear[slot] > 0 ? GEAR_BONUS[gear[slot] - 1] : 0), 0)
/** Why a tier can't be bought yet ("Needs the gear shed", "Needs gear shed II", "Needs Lv 3"); null when the shed and the level allow it */
export function gearGate(shed: number, level: number, tier: number): string | null {
  const needs = GEAR_NEEDS[tier - 1]
  if (shed < needs.shed) return needs.shed === 1 ? 'Needs the gear shed' : 'Needs gear shed II'
  if (level < needs.level) return `Needs Lv ${needs.level}`
  return null
}
