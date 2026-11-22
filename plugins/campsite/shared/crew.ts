// The camp's crew (campsite part 2): named hikers a session borrows for its run. A new session gets
// the free member who has rested longest; with none free it is a day hiker (no member, no XP). A
// member earns XP equal to the wood its session earns. Pure.
import type { Camp, CampSnapshot, CrewMember } from './camp.ts'
import { fnv1a } from './hiker.ts'

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

/** The session closed (or is gone): its member rests from now */
export function release(camp: Camp, terminalId: string, now: number): void {
  if (!Object.hasOwn(camp.assignments, terminalId)) return
  const member = camp.crew.find((m) => m.id === camp.assignments[terminalId].crew)
  delete camp.assignments[terminalId]
  if (member) member.restedAt = now
}

export function creditXp(camp: Camp, terminalId: string, xp: number): void {
  if (xp <= 0 || !Object.hasOwn(camp.assignments, terminalId)) return
  const member = camp.crew.find((m) => m.id === camp.assignments[terminalId].crew)
  if (member) member.xp += xp
}

/** Level n from 100 × (n − 1)² XP: 1 at 0, 2 at 100, 3 at 400, 4 at 900, 5 at 1600 */
export const levelFor = (xp: number): number => Math.floor(Math.sqrt(Math.max(0, xp) / 100)) + 1
export const titleFor = (level: number): string => TITLES[Math.min(Math.max(level, 1), TITLES.length) - 1]

/** "Aspen · Lv 2 Trailblazer", or "Day hiker" for a session with no member */
export function crewLabel(snap: CampSnapshot, terminalId: string): string {
  const id = Object.hasOwn(snap.assignments, terminalId) ? snap.assignments[terminalId] : undefined
  const member = id === undefined ? undefined : snap.crew.find((m) => m.id === id)
  return member ? `${member.name} · Lv ${member.level} ${member.title}` : 'Day hiker'
}
