// Wildlife (campsite part 3d-2): 24 species, which of them the time of day, the season, the weather
// and the camp's buildings allow, and the server's minute roll for a sighting in a project (likelier
// while it is active, more so with ranger tower II; rares only with the tower). A sighting is logged
// in the field guide (how many, first and last), the last 30 sightings, the project's last species
// (never twice running) and the away card. Collection only: nothing here pays. `rand` is passed in,
// so the rolls are the caller's. The rules change the camp in place. Pure.
import type { Camp } from './camp.ts'
import { isRecord } from './catalog.ts'
import { isTimeZone, phaseAt, seasonAt, weatherOf, zonedDate, type Hemisphere, type Phase, type Season, type WeatherKind } from './world.ts'

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
/** A project is active with a working session, or within this long of its last activity */
export const ACTIVE_MS = 10 * 60_000

export const sightingChance = (active: boolean, tower: number): number => (active ? ACTIVE_CHANCE : QUIET_CHANCE) * (tower >= 2 ? TOWER_BOOST : 1)

/** Whether a project is active: a working session in it, or activity in the last ACTIVE_MS */
export function isActive(camp: Pick<Camp, 'spans' | 'lastActive'>, projectId: string, now: number): boolean {
  if (Object.values(camp.spans).some((s) => s.project === projectId)) return true
  return Object.hasOwn(camp.lastActive, projectId) && now - camp.lastActive[projectId] < ACTIVE_MS
}

/** The windows' clock as the server keeps it (the last `seen` ping's): its time zone (null: the server's own) and seasons */
export interface CampClock {
  tz: string | null
  seasons: Hemisphere
}
export const DEFAULT_CLOCK: Readonly<CampClock> = Object.freeze({ tz: null, seasons: 'north' })
const HEMISPHERES: readonly Hemisphere[] = ['north', 'south', 'off']
const isHemisphere = (x: unknown): x is Hemisphere => typeof x === 'string' && (HEMISPHERES as readonly string[]).includes(x)

/** A window's `seen { tz, seasons }`: each valid value is kept (an unknown time zone or a bad value leaves the one before). Whether the clock changed */
export function setClock(camp: Pick<Camp, 'clock'>, params: Record<string, unknown>): boolean {
  const tz = isTimeZone(params.tz) ? params.tz : camp.clock.tz
  const seasons = isHemisphere(params.seasons) ? params.seasons : camp.clock.seasons
  if (tz === camp.clock.tz && seasons === camp.clock.seasons) return false
  camp.clock = { tz, seasons }
  return true
}

/** A project's context now: the time of day and season by the windows' clock, its weather, the lake and the tower */
export function contextFor(camp: Pick<Camp, 'clock' | 'trails' | 'lastActive' | 'built'>, projectId: string, now: number): SightContext {
  const date = zonedDate(now, camp.clock.tz)
  const season = seasonAt(date, camp.clock.seasons)
  return {
    phase: phaseAt(date).phase,
    season,
    weather: weatherOf(Object.values(camp.trails), camp.lastActive, projectId, now, season).kind,
    built: { lake: camp.built.lake, tower: camp.built.tower }
  }
}

/** A species' page in the field guide: how many sightings, the first and the last (ms) */
export interface GuideEntry {
  count: number
  first: number
  last: number
}
export interface Sighting {
  species: string
  projectId: string
  at: number
}
/** The sightings kept */
export const SIGHTINGS_MAX = 30

/** Logs a sighting: the guide, the last sightings, the project's last species, the away tally (a species never seen before is new) */
export function recordSighting(camp: Pick<Camp, 'guide' | 'sightings' | 'lastSeen' | 'away'>, id: string, projectId: string, now: number): void {
  const page = Object.hasOwn(camp.guide, id) ? camp.guide[id] : undefined
  if (page) {
    page.count++
    page.last = now
  } else {
    camp.guide[id] = { count: 1, first: now, last: now }
    camp.away.newSpecies.push(id)
  }
  camp.sightings.push({ species: id, projectId, at: now })
  if (camp.sightings.length > SIGHTINGS_MAX) camp.sightings.splice(0, camp.sightings.length - SIGHTINGS_MAX)
  camp.lastSeen[projectId] = id
  camp.away.sightings++
}

/**
 * A project's minute roll: a sighting with sightingChance (one rand() call; `force` skips it, for the
 * smokes), its species by pickSpecies, logged. The species, or null (no sighting, or nothing allowed)
 */
export function rollSighting(camp: Camp, projectId: string, now: number, rand: () => number, force = false): string | null {
  if (!force && rand() >= sightingChance(isActive(camp, projectId, now), camp.built.tower)) return null
  const id = pickSpecies(contextFor(camp, projectId, now), Object.hasOwn(camp.lastSeen, projectId) ? camp.lastSeen[projectId] : null, rand)
  if (id === null) return null
  recordSighting(camp, id, projectId, now)
  return id
}

const num = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x)
const isPage = (x: unknown): x is GuideEntry => isRecord(x) && Number.isInteger(x.count) && (x.count as number) >= 1 && num(x.first) && num(x.last)
const isSighting = (x: unknown): x is Sighting => isRecord(x) && isSpecies(x.species) && typeof x.projectId === 'string' && num(x.at)

/** On load: guide pages, sightings, last species and a clock this version can't read are dropped (or set to the default); the camp is kept */
export function dropBadWildlife(camp: Pick<Camp, 'guide' | 'sightings' | 'lastSeen' | 'clock' | 'away'>): void {
  if (!isRecord(camp.guide)) camp.guide = {}
  for (const [id, page] of Object.entries(camp.guide)) if (!isSpecies(id) || !isPage(page)) delete camp.guide[id]
  camp.sightings = Array.isArray(camp.sightings) ? camp.sightings.filter(isSighting).slice(-SIGHTINGS_MAX) : []
  if (!isRecord(camp.lastSeen)) camp.lastSeen = {}
  for (const [projectId, id] of Object.entries(camp.lastSeen)) if (!isSpecies(id)) delete camp.lastSeen[projectId]
  const clock: unknown = camp.clock
  camp.clock = {
    tz: isRecord(clock) && isTimeZone(clock.tz) ? clock.tz : null,
    seasons: isRecord(clock) && isHemisphere(clock.seasons) ? clock.seasons : 'north'
  }
  const away = camp.away as unknown as Record<string, unknown>
  if (!num(away.sightings) || (away.sightings as number) < 0) camp.away.sightings = 0
  camp.away.newSpecies = Array.isArray(away.newSpecies) ? (away.newSpecies as unknown[]).filter(isSpecies) : []
}
