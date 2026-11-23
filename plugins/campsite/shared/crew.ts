// The camp's crew (campsite part 2): named hikers a session borrows while its agent runs. A launch
// gets the free member who has rested longest; with none free it is a day hiker (no member, no XP),
// and an automation's run tab always is one. A member comes back to camp when the agent stops
// (exits, is stopped by Trek, or the session closes). A member earns XP equal to the wood its
// session earns. Pure.
import { noteLevelUp } from './away.ts'
import { whole } from './catalog.ts'
import type { Camp, CampSnapshot, CrewMember } from './camp.ts'
import { fnv1a, lookFor, type Look } from './hiker.ts'

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
  return order.slice(0, START_CREW).map((o, i) => ({ id: `c${i + 1}`, name: o.name, seed: fnv1a(`${seed}:crew:${i}`), xp: 0, restedAt: now - (START_CREW - i) }))
}

/** The session's member (kept while it lives), or a new pick; null: a day hiker */
export function assign(camp: Camp, terminalId: string, projectId: string, now: number): string | null {
  const have = Object.hasOwn(camp.assignments, terminalId) ? camp.assignments[terminalId] : undefined
  if (have) return have.crew
  const busy = new Set(Object.values(camp.assignments).map((a) => a.crew))
  const free = camp.crew.filter((m) => !busy.has(m.id)).sort((a, b) => a.restedAt - b.restedAt)
  if (free.length === 0) return null
  camp.assignments[terminalId] = { crew: free[0].id, project: projectId }
  return free[0].id
}

/** The session's agent stopped (or the session closed or is gone): its member rests from now */
export function release(camp: Camp, terminalId: string, now: number): void {
  if (!Object.hasOwn(camp.assignments, terminalId)) return
  const member = camp.crew.find((m) => m.id === camp.assignments[terminalId].crew)
  delete camp.assignments[terminalId]
  if (member) member.restedAt = now
}

/** Credits a session's member with XP; a level reached is noted for the away card */
export function creditXp(camp: Camp, terminalId: string, xp: number): void {
  if (xp <= 0 || !Object.hasOwn(camp.assignments, terminalId)) return
  const member = camp.crew.find((m) => m.id === camp.assignments[terminalId].crew)
  if (!member) return
  const before = levelFor(member.xp)
  member.xp += xp
  const after = levelFor(member.xp)
  if (after > before) noteLevelUp(camp, member.id, after)
}

/** Level n from 100 × (n − 1)² XP: 1 at 0, 2 at 100, 3 at 400, 4 at 900, 5 at 1600 */
export const levelFor = (xp: number): number => Math.floor(Math.sqrt(Math.max(0, whole(xp)) / 100)) + 1
export const titleFor = (level: number): string => TITLES[Math.min(Math.max(level, 1), TITLES.length) - 1]

/** The XP where level n starts (100 × (n − 1)²) */
export const levelXp = (level: number): number => 100 * (Math.max(1, level) - 1) ** 2

/** A member's look, from its seed (a neutral jacket: it belongs to no provider) */
export const memberLook = (seed: number): Look => lookFor(`crew:${seed}`, 'crew')

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
