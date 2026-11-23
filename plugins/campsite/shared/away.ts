// The "While you were away" tally (campsite part 3a): what the camp earned since a window last saw
// it, by source, with markers and the crew's level-ups. Due once nobody has seen the camp for longer
// than AWAY_DUE_MS and it holds something to tell; `seen` starts it again only when it isn't due,
// `awaySeen` (the card's dismiss) always. The rules change the camp in place. Pure.
import type { Camp } from './camp.ts'
import { AWAY_DUE_MS } from './catalog.ts'

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
}

/** The card's facts (the snapshot's `away`): whole hours and whole wood; members by name */
export interface AwaySnapshot {
  hours: number
  wood: Record<AwaySource, number>
  markers: number
  levelUps: { name: string; level: number; title: string }[]
}

type Seen = Pick<Camp, 'away' | 'seenAt'>

export const newAway = (since: number): AwayTally => ({ since, wood: { work: 0, outcomes: 0, garden: 0, fishing: 0 }, markers: 0, levelUps: [] })

export function addAway(camp: Pick<Camp, 'away'>, source: AwaySource, wood: number, markers: number): void {
  camp.away.wood[source] += wood
  camp.away.markers += markers
}

export function noteLevelUp(camp: Pick<Camp, 'away'>, crewId: string, level: number): void {
  const had = camp.away.levelUps.find((u) => u.crewId === crewId)
  if (had) had.level = Math.max(had.level, level)
  else camp.away.levelUps.push({ crewId, level })
}

/** Something to tell: a whole wood from some source, a marker or a level-up */
export const awayHolds = (a: AwayTally): boolean => AWAY_SOURCES.some((k) => Math.floor(a.wood[k]) >= 1) || a.markers > 0 || a.levelUps.length > 0

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

/** "While you were away (9 h): 🪵 +212 — work 136 · garden 40 · fishing 36 · ⛳ +1 · Mira reached Lv 3 Mountaineer" */
export function awayText(a: AwaySnapshot): string {
  const total = AWAY_SOURCES.reduce((sum, k) => sum + a.wood[k], 0)
  const out: string[] = []
  if (total > 0) out.push(`🪵 +${total} — ${AWAY_SOURCES.filter((k) => a.wood[k] > 0).map((k) => `${k} ${a.wood[k]}`).join(' · ')}`)
  if (a.markers > 0) out.push(`⛳ +${a.markers}`)
  for (const u of a.levelUps) out.push(`${u.name} reached Lv ${u.level} ${u.title}`)
  return `While you were away (${a.hours} h): ${out.join(' · ')}`
}
