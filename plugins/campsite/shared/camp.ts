// The camp (campsite parts 2 and 3a): one per server, shared by every project. What it holds, a new
// one, version 1 → 2, a shape check for what camp.json held, and the snapshot windows see. Pure.
import { AWAY_SOURCES, awayDue, newAway, type AwaySnapshot, type AwayTally } from './away.ts'
import { BUILDING_IDS, startBuilt, type BuildingId } from './catalog.ts'
import { levelFor, levelXp, newCrew, titleFor } from './crew.ts'

export const CAMP_VERSION = 2
const HOUR_MS = 3_600_000

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
  version: 2
  seed: number
  /** With fractions (the warmth factor, the garden, fishing); shown floored */
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
  /** Each building's tier: the fire ring starts at 1, the rest at 0 (not built) */
  built: Record<BuildingId, number>
  /** What the camp earned since a window last saw it */
  away: AwayTally
  /** When a visible window last reported the camp seen */
  seenAt: number
  /** The names hired on `day` (YYYY-MM-DD, the server's local date): they leave that day's walk-ins */
  hired: { day: string; names: string[] }
  /** The last whole minute the tick has accounted for */
  lastTick: number
  savedAt: number
}

/** A member as windows see it: whole XP, and the XP where its next level starts */
export interface CrewEntry {
  id: string
  name: string
  seed: number
  level: number
  title: string
  xp: number
  next: number
}

/** What windows see (campsite.state) */
export interface CampSnapshot {
  wood: number
  markers: number
  crew: CrewEntry[]
  /** terminalId → crew id */
  assignments: Record<string, string>
  built: Record<BuildingId, number>
  /** Only while the away card is due */
  away?: AwaySnapshot
}

export function newCamp(seed: number, now: number): Camp {
  return {
    version: CAMP_VERSION,
    seed,
    wood: 0,
    markers: 0,
    warmth: 0.5,
    crew: newCrew(seed, now),
    assignments: {},
    spans: {},
    worked: {},
    waiting: {},
    caps: {},
    ledger: [],
    built: startBuilt(),
    away: newAway(now),
    seenAt: now,
    hired: { day: '', names: [] },
    lastTick: now,
    savedAt: now
  }
}

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x)
const num = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x)

/** camp.json as version 1 wrote it, given version 2's new fields (seen at its last save); anything else as it is */
export function migrateCamp(raw: unknown): unknown {
  if (!isRecord(raw) || raw.version !== 1) return raw
  const at = num(raw.savedAt) ? raw.savedAt : 0
  return { ...raw, version: 2, built: startBuilt(), away: newAway(at), seenAt: at, hired: { day: '', names: [] } }
}

function isAway(x: unknown): boolean {
  if (!isRecord(x) || !num(x.since) || !num(x.markers)) return false
  const wood = x.wood
  if (!isRecord(wood) || !AWAY_SOURCES.every((k) => num(wood[k]))) return false
  return Array.isArray(x.levelUps) && x.levelUps.every((u) => isRecord(u) && typeof u.crewId === 'string' && num(u.level))
}

/** Whether camp.json held a camp of this version (top-level shape; members and maps checked loosely) */
export function isCamp(x: unknown): x is Camp {
  if (!isRecord(x) || x.version !== CAMP_VERSION) return false
  if (![x.seed, x.wood, x.markers, x.warmth, x.lastTick, x.savedAt, x.seenAt].every(num)) return false
  if (!Array.isArray(x.crew) || !x.crew.every((m) => isRecord(m) && typeof m.id === 'string' && typeof m.name === 'string' && num(m.xp) && num(m.restedAt) && num(m.seed))) return false
  if (!Array.isArray(x.ledger) || !x.ledger.every((k) => typeof k === 'string')) return false
  const built = x.built
  if (!isRecord(built) || !BUILDING_IDS.every((id) => num(built[id]) && built[id] >= 0)) return false
  if (!isAway(x.away)) return false
  const hired = x.hired
  if (!isRecord(hired) || typeof hired.day !== 'string' || !Array.isArray(hired.names) || !hired.names.every((n) => typeof n === 'string')) return false
  return [x.assignments, x.spans, x.worked, x.waiting, x.caps].every(isRecord)
}

function awaySnapshot(camp: Camp, now: number): AwaySnapshot {
  const wood = { work: 0, outcomes: 0, garden: 0, fishing: 0 }
  for (const k of AWAY_SOURCES) wood[k] = Math.floor(camp.away.wood[k])
  const levelUps: AwaySnapshot['levelUps'] = []
  for (const u of camp.away.levelUps) {
    const member = camp.crew.find((m) => m.id === u.crewId)
    if (member) levelUps.push({ name: member.name, level: u.level, title: titleFor(u.level) })
  }
  return { hours: Math.floor((now - camp.away.since) / HOUR_MS), wood, markers: camp.away.markers, levelUps }
}

export function snapshot(camp: Camp, now: number): CampSnapshot {
  const assignments: Record<string, string> = {}
  for (const [id, a] of Object.entries(camp.assignments)) assignments[id] = a.crew
  const snap: CampSnapshot = {
    wood: Math.floor(camp.wood),
    markers: camp.markers,
    crew: camp.crew.map((m) => {
      const level = levelFor(m.xp)
      return { id: m.id, name: m.name, seed: m.seed, level, title: titleFor(level), xp: Math.floor(m.xp), next: levelXp(level + 1) }
    }),
    assignments,
    built: { ...camp.built }
  }
  if (awayDue(camp, now)) snap.away = awaySnapshot(camp, now)
  return snap
}
