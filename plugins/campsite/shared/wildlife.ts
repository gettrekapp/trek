// Wildlife (campsite part 3d-2): 24 species, which of them the time of day, the season, the weather
// and the camp's buildings allow (the lake for swimmers, the ranger tower for the rares), the draw
// of a sighting's species (never the one just seen) and a minute's chance of a sighting (likelier
// while the project is active, more so with ranger tower II). `rand` is passed in, so the rolls
// are the caller's. Pure.
import type { Phase, Season, WeatherKind } from './world.ts'

export type Move = 'walker' | 'flier' | 'swimmer'
/** What can change a species' weight: a time of day, a season or a weather */
export type Boost = Phase | Season | WeatherKind

export interface SpeciesDef {
  readonly id: string
  readonly name: string
  readonly move: Move
  /** Its weight in a draw (rares are drawn among themselves) */
  readonly weight: number
  /** Only at these times of day (default: any) */
  readonly phases?: readonly Phase[]
  /** Only in these seasons (default: any; ignored with the seasons off) */
  readonly seasons?: readonly Season[]
  /** The lake (swimmers), or the ranger tower (the rares) */
  readonly needs?: 'lake' | 'tower'
  /** Its weight × this at a time of day, in a season or in a weather */
  readonly boosts?: Readonly<Partial<Record<Boost, number>>>
}

const NOT_WINTER: readonly Season[] = ['spring', 'summer', 'autumn']

/** Every species, commons first (in the field guide's order), then the four rares */
export const SPECIES: readonly SpeciesDef[] = [
  { id: 'deer', name: 'Mule deer', move: 'walker', weight: 10, boosts: { dawn: 2, dusk: 2 } },
  { id: 'fox', name: 'Red fox', move: 'walker', weight: 6 },
  { id: 'rabbit', name: 'Snowshoe hare', move: 'walker', weight: 8 },
  { id: 'squirrel', name: 'Red squirrel', move: 'walker', weight: 10, phases: ['day', 'dawn', 'dusk'] },
  { id: 'chipmunk', name: 'Chipmunk', move: 'walker', weight: 8, phases: ['day'], seasons: NOT_WINTER },
  { id: 'raccoon', name: 'Raccoon', move: 'walker', weight: 5, phases: ['dusk', 'night'] },
  { id: 'skunk', name: 'Skunk', move: 'walker', weight: 3, phases: ['dusk', 'night'], seasons: NOT_WINTER },
  { id: 'porcupine', name: 'Porcupine', move: 'walker', weight: 2 },
  { id: 'marmot', name: 'Marmot', move: 'walker', weight: 4, phases: ['day'], seasons: NOT_WINTER },
  { id: 'bear', name: 'Black bear', move: 'walker', weight: 2, seasons: NOT_WINTER },
  { id: 'elk', name: 'Elk', move: 'walker', weight: 3, boosts: { autumn: 3 } },
  { id: 'owl', name: 'Great horned owl', move: 'flier', weight: 4, phases: ['night'] },
  { id: 'bat', name: 'Little brown bat', move: 'flier', weight: 4, phases: ['dusk', 'night'], seasons: NOT_WINTER },
  { id: 'hawk', name: 'Red-tailed hawk', move: 'flier', weight: 4, phases: ['day'] },
  { id: 'woodpecker', name: 'Woodpecker', move: 'flier', weight: 3, phases: ['day', 'dawn'] },
  { id: 'heron', name: 'Great blue heron', move: 'swimmer', weight: 3, needs: 'lake', seasons: NOT_WINTER },
  { id: 'duck', name: 'Mallard', move: 'swimmer', weight: 6, needs: 'lake' },
  { id: 'beaver', name: 'Beaver', move: 'swimmer', weight: 2, needs: 'lake', phases: ['dusk', 'night', 'dawn'] },
  { id: 'otter', name: 'River otter', move: 'swimmer', weight: 2, needs: 'lake' },
  { id: 'frog', name: 'Tree frog', move: 'swimmer', weight: 4, needs: 'lake', seasons: ['spring', 'summer'], boosts: { rain: 3 } },
  { id: 'moose', name: 'Moose', move: 'walker', weight: 1, needs: 'tower', boosts: { fog: 2 } },
  { id: 'lynx', name: 'Lynx', move: 'walker', weight: 1, needs: 'tower', seasons: ['autumn', 'winter'], phases: ['dusk', 'night'] },
  { id: 'wolf', name: 'Black wolf', move: 'walker', weight: 1, needs: 'tower', phases: ['dusk', 'night'] },
  { id: 'stag', name: 'White stag', move: 'walker', weight: 1, needs: 'tower', seasons: ['winter'] }
]

const BY_ID: ReadonlyMap<string, SpeciesDef> = new Map(SPECIES.map((s) => [s.id, s]))
/** A species this version knows (a newer server's are skipped: not drawn, not listed) */
export const isSpecies = (id: unknown): id is string => typeof id === 'string' && BY_ID.has(id)
export const species = (id: string): SpeciesDef | undefined => BY_ID.get(id)
export const isRare = (s: Pick<SpeciesDef, 'needs'>): boolean => s.needs === 'tower'

/** What decides which species may show: the project's time of day, season and weather, and the camp's lake and tower */
export interface SightContext {
  phase: Phase
  /** null: the seasons are off (season gates are ignored) */
  season: Season | null
  weather: WeatherKind
  built: { lake: number; tower: number }
}

/** Whether a species may show in a context */
export function allowed(s: SpeciesDef, c: SightContext): boolean {
  if (s.phases && !s.phases.includes(c.phase)) return false
  if (s.seasons && c.season !== null && !s.seasons.includes(c.season)) return false
  if (s.needs === 'lake' && c.built.lake < 1) return false
  if (s.needs === 'tower' && c.built.tower < 1) return false
  return true
}

/** A species' weight in a context: its own × its boosts for the time of day, the season and the weather */
export function weightIn(s: SpeciesDef, c: SightContext): number {
  const b = s.boosts ?? {}
  let w = s.weight * (b[c.phase] ?? 1) * (b[c.weather] ?? 1)
  if (c.season !== null) w *= b[c.season] ?? 1
  return w
}

/** One of `pool` by weight (one rand() call); null when it is empty */
function draw(pool: readonly SpeciesDef[], c: SightContext, rand: () => number): string | null {
  const total = pool.reduce((sum, s) => sum + weightIn(s, c), 0)
  if (pool.length === 0 || total <= 0) return null
  let r = rand() * total
  for (const s of pool) {
    r -= weightIn(s, c)
    if (r < 0) return s.id
  }
  return pool[pool.length - 1].id
}

/** A rare's chance, on each sighting with the tower */
export const RARE_CHANCE = 1 / 80

/**
 * The species of a sighting: with the tower, first a rare draw (RARE_CHANCE, one rand() call) among
 * the rares the context allows; otherwise (none allowed, or the draw missed) a weighted draw among
 * the allowed commons. The project's last species is never drawn. Null when nothing is allowed
 */
export function pickSpecies(c: SightContext, last: string | null, rand: () => number): string | null {
  const ok = SPECIES.filter((s) => s.id !== last && allowed(s, c))
  if (c.built.tower >= 1) {
    const rares = ok.filter(isRare)
    if (rand() < RARE_CHANCE && rares.length > 0) return draw(rares, c, rand)
  }
  return draw(ok.filter((s) => !isRare(s)), c, rand)
}

/** A minute's chance of a sighting in an active project, and in a quiet one */
export const ACTIVE_CHANCE = 1 / 20
export const QUIET_CHANCE = 1 / 120
/** Ranger tower II's lift */
export const TOWER_BOOST = 1.25

export const sightingChance = (active: boolean, tower: number): number => (active ? ACTIVE_CHANCE : QUIET_CHANCE) * (tower >= 2 ? TOWER_BOOST : 1)
