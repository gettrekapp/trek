// The camp (campsite part 2): one per server, shared by every project. What it holds, a new one, a
// shape check for what camp.json held, and the snapshot windows see. Pure.
import { levelFor, newCrew, titleFor } from './crew.ts'

export const CAMP_VERSION = 1

export interface CrewMember {
  id: string
  name: string
  /** Seeds its look */
  seed: number
  xp: number
  /** When it last came back to camp (ms): the longest-rested free member is picked first */
  restedAt: number
}

export interface Camp {
  version: 1
  seed: number
  /** With fractions (the warmth factor); shown floored */
  wood: number
  markers: number
  /** 0–1 */
  warmth: number
  crew: CrewMember[]
  /** Session (terminalId) → its member, and its project (for the prune) */
  assignments: Record<string, { crew: string; project: string }>
  /** Open working spans: since `start`, `paid` whole minutes paid */
  spans: Record<string, { start: number; paid: number; project: string }>
  /** Whole working minutes since the session's last paid completion */
  worked: Record<string, number>
  /** Sessions waiting on the user: since when, and why */
  waiting: Record<string, { since: number; attention: boolean; decision: boolean; project: string }>
  /** `<cap>:<hour>` → uses this hour */
  caps: Record<string, number>
  /** Recent reward keys, oldest first */
  ledger: string[]
  /** The last whole minute the tick has accounted for */
  lastTick: number
  savedAt: number
}

/** What windows see (campsite.state) */
export interface CampSnapshot {
  wood: number
  markers: number
  crew: { id: string; name: string; level: number; title: string }[]
  /** terminalId → crew id */
  assignments: Record<string, string>
}

export function newCamp(seed: number, now: number): Camp {
  return { version: CAMP_VERSION, seed, wood: 0, markers: 0, warmth: 0.5, crew: newCrew(seed, now), assignments: {}, spans: {}, worked: {}, waiting: {}, caps: {}, ledger: [], lastTick: now, savedAt: now }
}

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x)
const num = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x)

/** Whether camp.json held a camp of this version (top-level shape; members and maps checked loosely) */
export function isCamp(x: unknown): x is Camp {
  if (!isRecord(x) || x.version !== CAMP_VERSION) return false
  if (![x.seed, x.wood, x.markers, x.warmth, x.lastTick, x.savedAt].every(num)) return false
  if (!Array.isArray(x.crew) || !x.crew.every((m) => isRecord(m) && typeof m.id === 'string' && typeof m.name === 'string' && num(m.xp) && num(m.restedAt) && num(m.seed))) return false
  if (!Array.isArray(x.ledger) || !x.ledger.every((k) => typeof k === 'string')) return false
  return [x.assignments, x.spans, x.worked, x.waiting, x.caps].every(isRecord)
}

export function snapshot(camp: Camp): CampSnapshot {
  const assignments: Record<string, string> = {}
  for (const [id, a] of Object.entries(camp.assignments)) assignments[id] = a.crew
  return {
    wood: Math.floor(camp.wood),
    markers: camp.markers,
    crew: camp.crew.map((m) => {
      const level = levelFor(m.xp)
      return { id: m.id, name: m.name, level, title: titleFor(level) }
    }),
    assignments
  }
}
