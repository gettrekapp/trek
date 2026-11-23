// The camp (campsite parts 2, 3a and 3b): one per server, shared by every project. What it holds, a
// new one, versions 1 → 2 → 3, a shape check for what camp.json held, and the snapshot windows see.
// Pure.
import { AWAY_SOURCES, awayDue, newAway, noWood, type AwaySnapshot, type AwayTally } from './away.ts'
import { BUILDING_IDS, GEAR_SLOTS, GEAR_TOP, HOUR_MS, building, gearBonus, hireCost, isRecord, noGear, startBuilt, whole, type BuildingId, type GearTiers } from './catalog.ts'
import { levelFor, levelXp, liveKinds, newCrew, titleFor } from './crew.ts'
import type { JournalEntry } from './journal.ts'
import { bunks, offers, todaysCandidates, type Candidate, type Offer } from './shop.ts'

export const CAMP_VERSION = 3

/** What a member goes out on: sessions of a type, or of an agent (provider); null: any session */
export type Pin = { kind: 'type' | 'provider'; id: string }
/** A session type or an agent the camp saw a session start with, by its name then, and when last */
export interface SeenKind {
  kind: 'type' | 'provider'
  id: string
  name: string
  at: number
}

export interface CrewMember {
  id: string
  name: string
  /** Seeds its look */
  seed: number
  xp: number
  /** When it last came back to camp (ms): the longest-rested free member is picked first */
  restedAt: number
  /** Its tier in each gear slot (0: none) */
  gear: GearTiers
  pin: Pin | null
  /** Newest last, at most JOURNAL_MAX */
  journal: JournalEntry[]
}

/** A session's member, and where the trip is (for the prune and the journal) */
export interface Assignment {
  crew: string
  /** The project's id */
  project: string
  /** null: a Global session */
  worktreeId: string | null
  /** The session's agent ('' when not known) */
  provider: string
  /** The project's name and the session's place (the worktree's branch, else its folder, or "Global"), when it was assigned */
  projectName: string
  place: string
  /** When the member went out */
  start: number
  /** Wood credited to the member on this trip (its gear's bonus included) */
  wood: number
}

export interface Camp {
  version: 3
  seed: number
  /** With fractions (the warmth factor, the garden, fishing); shown floored */
  wood: number
  markers: number
  /** 0–1 */
  warmth: number
  crew: CrewMember[]
  /** Session (terminalId) → its member and its trip */
  assignments: Record<string, Assignment>
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
  /** Session types and agents sessions started with, for pinning (older than SEEN_KIND_MS are dropped) */
  seenKinds: SeenKind[]
  /** The last whole minute the tick has accounted for */
  lastTick: number
  savedAt: number
}

/** A member as windows see it: whole XP, and the XP where its next level starts; its gear, the bonus it gives (percent), its pin and journal */
export interface CrewEntry {
  id: string
  name: string
  seed: number
  level: number
  title: string
  xp: number
  next: number
  gear: GearTiers
  bonus: number
  pin: Pin | null
  journal: JournalEntry[]
}

/** What windows see (campsite.state) */
export interface CampSnapshot {
  wood: number
  markers: number
  crew: CrewEntry[]
  /** terminalId → crew id */
  assignments: Record<string, string>
  built: Record<BuildingId, number>
  /** Each building's next tier, at its price */
  offers: Offer[]
  bunks: number
  /** Today's walk-ins */
  candidates: Candidate[]
  /** The next hire's price */
  recruitCost: number
  /** The session types and agents a member can be pinned to (seen in the last 30 days): types first, then agents, by name */
  seenKinds: Omit<SeenKind, 'at'>[]
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
    seenKinds: [],
    lastTick: now,
    savedAt: now
  }
}

const num = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x)

/**
 * camp.json as version 1 or 2 wrote it, brought to version 3: version 1 gains version 2's fields
 * (seen at its last save); version 2 gains the shed (not built), each member no gear, no pin and an
 * empty journal, each trip its start (the last save) and no wood, and no seen kinds. Anything else as
 * it is.
 */
export function migrateCamp(raw: unknown): unknown {
  if (!isRecord(raw)) return raw
  const at = num(raw.savedAt) ? raw.savedAt : 0
  let out: Record<string, unknown> = raw
  if (out.version === 1) out = { ...out, version: 2, built: startBuilt(), away: newAway(at), seenAt: at, hired: { day: '', names: [] } }
  if (out.version !== 2) return out
  const crew = Array.isArray(out.crew) ? out.crew.map((m: unknown) => (isRecord(m) ? { ...m, gear: noGear(), pin: null, journal: [] } : m)) : out.crew
  const assignments = isRecord(out.assignments)
    ? Object.fromEntries(
        Object.entries(out.assignments).map(([id, a]) => [id, isRecord(a) ? { ...a, worktreeId: null, provider: '', projectName: typeof a.project === 'string' ? a.project : '', place: '', start: at, wood: 0 } : a])
      )
    : out.assignments
  const built = isRecord(out.built) ? { ...out.built, shed: 0 } : out.built
  return { ...out, version: 3, crew, assignments, built, seenKinds: [] }
}

function isAway(x: unknown): boolean {
  if (!isRecord(x) || !num(x.since) || !num(x.markers)) return false
  const wood = x.wood
  if (!isRecord(wood) || !AWAY_SOURCES.every((k) => num(wood[k]))) return false
  return Array.isArray(x.levelUps) && x.levelUps.every((u) => isRecord(u) && typeof u.crewId === 'string' && num(u.level))
}

const isGear = (g: unknown): boolean => isRecord(g) && GEAR_SLOTS.every((slot) => Number.isInteger(g[slot]) && (g[slot] as number) >= 0 && (g[slot] as number) <= GEAR_TOP)
const isKind = (k: unknown): boolean => k === 'type' || k === 'provider'
const isPin = (p: unknown): boolean => p === null || (isRecord(p) && isKind(p.kind) && typeof p.id === 'string')
const isMember = (m: unknown): boolean =>
  isRecord(m) &&
  typeof m.id === 'string' &&
  typeof m.name === 'string' &&
  num(m.xp) &&
  num(m.restedAt) &&
  num(m.seed) &&
  isGear(m.gear) &&
  isPin(m.pin) &&
  Array.isArray(m.journal)

/** An assignment this version can read (restore drops any other; a bad one doesn't make camp.json no camp) */
export const isAssignment = (a: unknown): a is Assignment =>
  isRecord(a) &&
  typeof a.crew === 'string' &&
  typeof a.project === 'string' &&
  (a.worktreeId === null || typeof a.worktreeId === 'string') &&
  typeof a.provider === 'string' &&
  typeof a.projectName === 'string' &&
  typeof a.place === 'string' &&
  num(a.start) &&
  num(a.wood)

/** Whether camp.json held a camp of this version (top-level shape; members checked, maps loosely; journal entries and assignments are checked one by one in restore, which drops the bad ones) */
export function isCamp(x: unknown): x is Camp {
  if (!isRecord(x) || x.version !== CAMP_VERSION) return false
  if (![x.seed, x.wood, x.markers, x.warmth, x.lastTick, x.savedAt, x.seenAt].every(num)) return false
  if (!Array.isArray(x.crew) || !x.crew.every(isMember)) return false
  if (!Array.isArray(x.seenKinds) || !x.seenKinds.every((k) => isRecord(k) && isKind(k.kind) && typeof k.id === 'string' && typeof k.name === 'string' && num(k.at))) return false
  if (!Array.isArray(x.ledger) || !x.ledger.every((k) => typeof k === 'string')) return false
  const built = x.built
  if (!isRecord(built) || !BUILDING_IDS.every((id) => Number.isInteger(built[id]) && (built[id] as number) >= building(id).start && (built[id] as number) <= building(id).tiers.length)) return false
  if (!isAway(x.away)) return false
  const hired = x.hired
  if (!isRecord(hired) || typeof hired.day !== 'string' || !Array.isArray(hired.names) || !hired.names.every((n) => typeof n === 'string')) return false
  return [x.assignments, x.spans, x.worked, x.waiting, x.caps].every(isRecord)
}

function awaySnapshot(camp: Camp, now: number): AwaySnapshot {
  const wood = noWood()
  for (const k of AWAY_SOURCES) wood[k] = whole(camp.away.wood[k])
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
    wood: whole(camp.wood),
    markers: camp.markers,
    crew: camp.crew.map((m) => {
      const level = levelFor(m.xp)
      return { id: m.id, name: m.name, seed: m.seed, level, title: titleFor(level), xp: whole(m.xp), next: whole(levelXp(level + 1)), gear: { ...m.gear }, bonus: gearBonus(m.gear), pin: m.pin && { ...m.pin }, journal: m.journal.map((e) => ({ ...e })) }
    }),
    assignments,
    built: { ...camp.built },
    offers: offers(camp),
    bunks: bunks(camp),
    candidates: todaysCandidates(camp, now),
    recruitCost: hireCost(camp.crew.length),
    seenKinds: liveKinds(camp, now)
  }
  if (awayDue(camp, now)) snap.away = awaySnapshot(camp, now)
  return snap
}
