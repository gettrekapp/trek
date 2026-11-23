// The "While you were away" tally (campsite part 3a): what the camp earned since a window last saw
// it, by source, with markers and the crew's level-ups, and the sightings (part 3d-2). Due once nobody has seen the camp for longer
// than AWAY_DUE_MS and it holds something to tell (sightings only with a new species); `seen` starts it again only when it isn't due,
// `awaySeen` (the card's dismiss) always. The rules change the camp in place. Pure.
import type { Camp } from './camp.ts'
import { AWAY_DUE_MS, whole } from './catalog.ts'
import { species } from './wildlife.ts'

export const AWAY_SOURCES = ['work', 'outcomes', 'garden', 'fishing'] as const
export type AwaySource = (typeof AWAY_SOURCES)[number]

export interface AwayTally {
  /** When the tally started */
  since: number
  /** Wood by source, with fractions */
  wood: Record<AwaySource, number>
  markers: number
  /** Members whose level rose, at the level they reached */
  levelUps: { crewId: string; level: number }[]
  /** Sightings (part 3d-2), and the species first seen among them (ids, in order) */
  sightings: number
  newSpecies: string[]
}

/** The card's facts (the snapshot's `away`): whole hours and whole wood; members by name */
export interface AwaySnapshot {
  hours: number
  wood: Record<AwaySource, number>
  markers: number
  levelUps: { name: string; level: number; title: string }[]
  /** Sightings, and the species first seen among them by name (an older server: absent) */
  sightings?: number
  newSpecies?: string[]
}

type Seen = Pick<Camp, 'away' | 'seenAt'>

/** A zero for every source */
export function noWood(): Record<AwaySource, number> {
  const out = {} as Record<AwaySource, number>
  for (const k of AWAY_SOURCES) out[k] = 0
  return out
}

export const newAway = (since: number): AwayTally => ({ since, wood: noWood(), markers: 0, levelUps: [], sightings: 0, newSpecies: [] })

export function addAway(camp: Pick<Camp, 'away'>, source: AwaySource, wood: number, markers: number): void {
  camp.away.wood[source] += wood
  camp.away.markers += markers
}

export function noteLevelUp(camp: Pick<Camp, 'away'>, crewId: string, level: number): void {
  const had = camp.away.levelUps.find((u) => u.crewId === crewId)
  if (had) had.level = Math.max(had.level, level)
  else camp.away.levelUps.push({ crewId, level })
}

/**
 * Something to tell: a whole wood from some source, a marker, a level-up or a new species. Sightings
 * of species already in the guide aren't enough on their own (nearly every long absence has one);
 * they still show on a card that is due for something else
 */
export const awayHolds = (a: AwayTally): boolean =>
  AWAY_SOURCES.some((k) => whole(a.wood[k]) >= 1) || a.markers > 0 || a.levelUps.length > 0 || a.newSpecies.some((id) => species(id) !== undefined)

/** The new species' names, for the card (ids this version doesn't know are left out) */
export const newSpeciesNames = (ids: readonly string[]): string[] => ids.flatMap((id) => species(id)?.name ?? [])

export const awayDue = (camp: Seen, now: number): boolean => now - camp.seenAt > AWAY_DUE_MS && awayHolds(camp.away)

/** A visible window saw the camp: the tally starts again, unless the card is due (then nothing, so it isn't lost before anyone reads it). Whether it changed the camp */
export function seen(camp: Seen, now: number): boolean {
  if (awayDue(camp, now)) return false
  camp.away = newAway(now)
  camp.seenAt = now
  return true
}

/** The card was dismissed */
export function awaySeen(camp: Seen, now: number): void {
  camp.away = newAway(now)
  camp.seenAt = now
}

/** "While you were away (9 h): 🪵 +212 — work 136 · garden 40 · fishing 36 · ⛳ +1 · Mira reached Lv 3 Mountaineer · 12 sightings · 2 new species: Great blue heron, Lynx" */
export function awayText(a: AwaySnapshot): string {
  // The sum of the floored parts, so the line adds up as shown
  const total = AWAY_SOURCES.reduce((sum, k) => sum + a.wood[k], 0)
  const out: string[] = []
  if (total > 0) out.push(`🪵 +${total} — ${AWAY_SOURCES.filter((k) => a.wood[k] > 0).map((k) => `${k} ${a.wood[k]}`).join(' · ')}`)
  if (a.markers > 0) out.push(`⛳ +${a.markers}`)
  for (const u of a.levelUps) out.push(`${u.name} reached Lv ${u.level} ${u.title}`)
  const seen = a.sightings ?? 0
  if (seen > 0) out.push(seen === 1 ? '1 sighting' : `${seen} sightings`)
  const fresh = a.newSpecies ?? []
  if (fresh.length > 0) out.push(`${fresh.length} new species: ${fresh.join(', ')}`)
  return `While you were away (${a.hours} h): ${out.join(' · ')}`
}
