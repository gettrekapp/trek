// The camp's crew (campsite parts 2 and 3b): named hikers a session borrows while its agent runs. A
// launch gets a free member: first one pinned to the session's type, then one pinned to its agent,
// then the longest-rested unpinned one; with none it is a day hiker (no member, no XP), and an
// automation's run tab always is one. A member comes back to camp when the agent stops (exits, is
// stopped by Trek, or the session closes), and its journal notes the trip. A member earns XP equal to
// the wood credited to its session. Pure.
import type { ActivitySessionType } from '../../../src/shared/plugins/activity.ts'
import { noteLevelUp } from './away.ts'
import { SEEN_KIND_MS, isRecord, noGear, whole } from './catalog.ts'
import type { Camp, CampSnapshot, CrewMember, SeenKind } from './camp.ts'
import type { JournalEntry } from './journal.ts'
import { fnv1a, kitKey, lookFor, type Look } from './hiker.ts'
import { note, providerName } from './journal.ts'
import type { ShopRefusal } from './shop.ts'

export const TRAIL_NAMES: readonly string[] = [
  'Aspen', 'Birch', 'Cedar', 'Juniper', 'Willow', 'Hazel', 'Rowan', 'Alder', 'Sage', 'Fern',
  'Moss', 'Laurel', 'Holly', 'Ivy', 'Clover', 'Heather', 'Reed', 'Ash', 'Oak', 'Pine',
  'Spruce', 'Larch', 'Maple', 'Linden', 'Yarrow', 'Thistle', 'Bracken', 'Briar', 'Wren', 'Finch',
  'Robin', 'Jay', 'Lark', 'Kestrel', 'Heron', 'Otter', 'Marten', 'Fox', 'Ridge', 'Brook'
]
export const START_CREW = 3
export const TITLES: readonly string[] = ['Tenderfoot', 'Trailblazer', 'Mountaineer', 'Sherpa', 'Legend']

/** The starting crew: names in a seeded order without repeats; restedAt staggered so the first is picked first */
export function newCrew(seed: number, now: number): CrewMember[] {
  const order = TRAIL_NAMES.map((name, i) => ({ name, k: fnv1a(`${seed}:${i}`) })).sort((a, b) => a.k - b.k)
  return order.slice(0, START_CREW).map((o, i) => ({
    id: `c${i + 1}`,
    name: o.name,
    seed: fnv1a(`${seed}:crew:${i}`),
    xp: 0,
    restedAt: now - (START_CREW - i),
    gear: noGear(),
    pin: null,
    journal: [{ kind: 'hired', at: now }]
  }))
}

/** What a session is, for picking its member: where it runs, its agent and its type */
export interface Launch {
  /** null: a Global session */
  worktreeId: string | null
  /** '' when not known */
  provider: string
  sessionType: ActivitySessionType | null
}
export const NO_LAUNCH: Launch = { worktreeId: null, provider: '', sessionType: null }

/**
 * What the server can say about where a session is (the host's lookups), for the journal. Neither
 * method throws: when the host can't say, `project` returns the id and `worktree` null. (The rules
 * guard against one that throws anyway: a throw counts as "can't say".)
 */
export interface Where {
  /** The project's name (its id when the server can't say) */
  project(projectId: string): string
  /** A worktree's repository, branch (null: detached) and folder name; null when it is gone or the server can't say */
  worktree(projectId: string, worktreeId: string): { repoId: string; branch: string | null; name: string } | null
}
export const NO_WHERE: Where = { project: (id) => id, worktree: () => null }

/** `where.project`, the id if it throws */
function projectName(where: Where, projectId: string): string {
  try {
    return where.project(projectId)
  } catch {
    return projectId
  }
}
/** `where.worktree`, null if it throws */
function worktreeOf(where: Where, projectId: string, worktreeId: string): ReturnType<Where['worktree']> {
  try {
    return where.worktree(projectId, worktreeId)
  } catch {
    return null
  }
}

/** A session type's id among the seen kinds and pins: per project (two projects' types may share an id); agents are not */
export const typeKey = (projectId: string, typeId: string): string => `${projectId}:${typeId}`

const MINUTE_MS = 60_000

/** The member out on a session, if any */
export function memberOf(camp: Pick<Camp, 'crew' | 'assignments'>, terminalId: string): CrewMember | undefined {
  const a = Object.hasOwn(camp.assignments, terminalId) ? camp.assignments[terminalId] : undefined
  return a && camp.crew.find((m) => m.id === a.crew)
}

/** The most seen kinds kept (the newest) */
export const SEEN_KINDS_MAX = 50

/**
 * A session started with `launch` in `projectId`: its type (keyed by the project, with the project's
 * name from `where`) and its agent are seen now. Kinds unseen for SEEN_KIND_MS are dropped, and past
 * SEEN_KINDS_MAX the oldest.
 */
export function noteKinds(camp: Pick<Camp, 'seenKinds'>, launch: Launch, now: number, projectId: string, where: Where = NO_WHERE): void {
  const see = (kind: SeenKind['kind'], id: string, name: string, project?: string): void => {
    const had = camp.seenKinds.find((k) => k.kind === kind && k.id === id)
    if (had) {
      had.name = name
      had.at = now
      if (project !== undefined) had.project = project
    } else camp.seenKinds.push(project === undefined ? { kind, id, name, at: now } : { kind, id, name, at: now, project })
  }
  if (launch.sessionType) see('type', typeKey(projectId, launch.sessionType.id), launch.sessionType.name, projectName(where, projectId))
  if (launch.provider) see('provider', launch.provider, providerName(launch.provider))
  camp.seenKinds = camp.seenKinds.filter((k) => now - k.at <= SEEN_KIND_MS)
  if (camp.seenKinds.length > SEEN_KINDS_MAX) {
    const keep = new Set([...camp.seenKinds].sort((a, b) => b.at - a.at).slice(0, SEEN_KINDS_MAX))
    camp.seenKinds = camp.seenKinds.filter((k) => keep.has(k))
  }
}

/**
 * The session's member (kept while it lives), or a new pick from the free members: one pinned to the
 * session's type, else one pinned to its agent, else the longest-rested unpinned one (a pinned member
 * never goes out on another session); null: a day hiker. The trip notes where it is.
 */
export function assign(camp: Camp, terminalId: string, projectId: string, now: number, launch: Launch = NO_LAUNCH, where: Where = NO_WHERE): string | null {
  const have = Object.hasOwn(camp.assignments, terminalId) ? camp.assignments[terminalId] : undefined
  if (have) return have.crew
  const busy = new Set(Object.values(camp.assignments).map((a) => a.crew))
  const free = camp.crew.filter((m) => !busy.has(m.id)).sort((a, b) => a.restedAt - b.restedAt)
  const type = launch.sessionType && typeKey(projectId, launch.sessionType.id)
  const pick =
    (type ? free.find((m) => m.pin?.kind === 'type' && m.pin.id === type) : undefined) ??
    free.find((m) => m.pin?.kind === 'provider' && m.pin.id === launch.provider) ??
    free.find((m) => m.pin === null)
  if (!pick) return null
  let place = 'Global'
  if (launch.worktreeId !== null) {
    const worktree = worktreeOf(where, projectId, launch.worktreeId)
    place = worktree ? (worktree.branch ?? worktree.name) : 'a worktree'
  }
  camp.assignments[terminalId] = { crew: pick.id, project: projectId, worktreeId: launch.worktreeId, provider: launch.provider, projectName: projectName(where, projectId), place, start: now, wood: 0 }
  return pick.id
}

/** The session's agent stopped (or the session closed or is gone): its member rests from now, and a trip of a whole minute or more goes in its journal */
export function release(camp: Camp, terminalId: string, now: number): void {
  if (!Object.hasOwn(camp.assignments, terminalId)) return
  const a = camp.assignments[terminalId]
  const member = camp.crew.find((m) => m.id === a.crew)
  delete camp.assignments[terminalId]
  if (!member) return
  member.restedAt = now
  const minutes = Math.floor((now - a.start) / MINUTE_MS)
  if (minutes >= 1) note(member, { kind: 'trip', at: now, minutes, project: a.projectName, place: a.place, provider: a.provider, wood: whole(a.wood) })
}

/** Credits a session's member with XP (and its trip with the wood); a level reached is noted for the away card and in its journal */
export function creditXp(camp: Camp, terminalId: string, xp: number, now: number): void {
  if (xp <= 0 || !Object.hasOwn(camp.assignments, terminalId)) return
  const a = camp.assignments[terminalId]
  const member = camp.crew.find((m) => m.id === a.crew)
  if (!member) return
  a.wood += xp
  const before = levelFor(member.xp)
  member.xp += xp
  const after = levelFor(member.xp)
  if (after > before) {
    noteLevelUp(camp, member.id, after)
    note(member, { kind: 'level', at: now, level: after, title: titleFor(after) })
  }
}

/** A pull request merged: each member out on a session in its branch's worktree (the host says which branch a worktree has) summited */
export function summit(camp: Camp, pr: { projectId: string; repoId: string; branch: string }, now: number, where: Where): void {
  for (const a of Object.values(camp.assignments)) {
    if (a.project !== pr.projectId || a.worktreeId === null) continue
    const worktree = worktreeOf(where, a.project, a.worktreeId)
    if (!worktree || worktree.repoId !== pr.repoId || worktree.branch !== pr.branch) continue
    const member = camp.crew.find((m) => m.id === a.crew)
    if (member) note(member, { kind: 'summit', at: now, branch: pr.branch, project: a.projectName })
  }
}

/** Level n from 100 × (n − 1)² XP: 1 at 0, 2 at 100, 3 at 400, 4 at 900, 5 at 1600 */
export const levelFor = (xp: number): number => Math.floor(Math.sqrt(Math.max(0, whole(xp)) / 100)) + 1
export const titleFor = (level: number): string => TITLES[Math.min(Math.max(level, 1), TITLES.length) - 1]

/** The XP where level n starts (100 × (n − 1)²) */
export const levelXp = (level: number): number => 100 * (Math.max(1, level) - 1) ** 2

/** A member's look, from its seed (a neutral jacket: it belongs to no provider) */
export const memberLook = (seed: number): Look => lookFor(`crew:${seed}`, 'crew')

/** The kinds seen in the last SEEN_KIND_MS: session types first, then agents, each by name */
export function liveKinds(camp: Pick<Camp, 'seenKinds'>, now: number): Omit<SeenKind, 'at'>[] {
  return camp.seenKinds
    .filter((k) => now - k.at <= SEEN_KIND_MS)
    .sort((a, b) => (a.kind === b.kind ? (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) : a.kind === 'type' ? -1 : 1))
    .map(({ kind, id, name, project }) => (project === undefined ? { kind, id, name } : { kind, id, name, project }))
}

/**
 * Pins `{ crewId, pin }`: to a session type (its typeKey) or an agent the camp saw start a session in
 * the last 30 days, or null (any session); it keeps the kind's name (a request's name is not taken).
 * The same pin again changes nothing; a change goes in the journal. A pin only steers the next pick: a member already out on a session that doesn't match
 * finishes its current trip there.
 */
export function pinMember(camp: Camp, params: Record<string, unknown>, now: number): ShopRefusal | null {
  const { crewId, pin } = params
  const shaped = pin === null || (isRecord(pin) && (pin.kind === 'type' || pin.kind === 'provider') && typeof pin.id === 'string')
  if (typeof crewId !== 'string' || !shaped) return { code: 'BAD_REQUEST', message: 'A pin needs { crewId, pin: { kind, id } or null }' }
  const member = camp.crew.find((m) => m.id === crewId)
  if (!member) return { code: 'CONFLICT', message: `Nobody in the crew is ${crewId.slice(0, 40)}` }
  const want = pin === null ? null : liveKinds(camp, now).find((k) => k.kind === pin.kind && k.id === pin.id)
  if (want === undefined) return { code: 'CONFLICT', message: 'No session of that type or agent started here in the last 30 days' }
  const was = member.pin
  if (was?.kind === want?.kind && was?.id === want?.id) return null
  member.pin = want && { kind: want.kind, id: want.id, name: want.name }
  if (want) note(member, { kind: 'pinned', at: now, name: want.name })
  else if (was) note(member, { kind: 'unpinned', at: now, name: was.name })
  return null
}

/** `journal { crewId }`: a member's journal entries, oldest first (copies) */
export function journalOf(camp: Pick<Camp, 'crew'>, params: Record<string, unknown>): ShopRefusal | { journal: JournalEntry[] } {
  const { crewId } = params
  if (typeof crewId !== 'string') return { code: 'BAD_REQUEST', message: 'A journal needs { crewId }' }
  const member = camp.crew.find((m) => m.id === crewId)
  if (!member) return { code: 'NOT_FOUND', message: `Nobody in the crew is ${crewId.slice(0, 40)}` }
  return { journal: member.journal.map((e) => ({ ...e })) }
}

/** Members with no session: resting at camp */
export function restingCount(camp: Pick<Camp, 'crew' | 'assignments'>): number {
  const busy = new Set(Object.values(camp.assignments).map((a) => a.crew))
  return camp.crew.filter((m) => !busy.has(m.id)).length
}

/** "Aspen · Lv 2 Trailblazer", or "Day hiker" for a session with no member */
export function crewLabel(snap: CampSnapshot, terminalId: string): string {
  const id = Object.hasOwn(snap.assignments, terminalId) ? snap.assignments[terminalId] : undefined
  const member = id === undefined ? undefined : snap.crew.find((m) => m.id === id)
  return member ? `${member.name} · Lv ${member.level} ${member.title}` : 'Day hiker'
}

/** The kitKey of the gear the session's member wears ('' for a day hiker, or a member with none) */
export function sessionKit(snap: Pick<CampSnapshot, 'crew' | 'assignments'>, terminalId: string): string {
  const id = Object.hasOwn(snap.assignments, terminalId) ? snap.assignments[terminalId] : undefined
  const member = id === undefined ? undefined : snap.crew.find((m) => m.id === id)
  return member ? kitKey(member.gear) : ''
}

/** Each geared session's kitKey, as one string (JSON of [terminalId, kit] pairs by id): the same string while no gear or assignment of a geared member changes */
export function kitsKey(snap: Pick<CampSnapshot, 'crew' | 'assignments'>): string {
  const pairs: [string, string][] = []
  for (const id of Object.keys(snap.assignments).sort()) {
    const kit = sessionKit(snap, id)
    if (kit) pairs.push([id, kit])
  }
  return JSON.stringify(pairs)
}

/** The sessions' kits a kitsKey holds (terminalId → kitKey), with no prototype: only its own keys answer */
export function kitsOf(key: string): Record<string, string> {
  const out = Object.create(null) as Record<string, string>
  for (const [id, kit] of JSON.parse(key) as [string, string][]) out[id] = kit
  return out
}
