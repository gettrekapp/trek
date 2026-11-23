// A crew member's trail journal (campsite part 3b): what it did, as data, newest last, at most
// JOURNAL_MAX; and its words for the member view, made where it is shown so they can change ("3 h
// 12 m on main in trek with Claude · 🪵 48", "Summited feature/x in trek", "Reported on feature/x: Tests are
// green.", "2 h ago"). Pure.
import { GEAR_TOP, HOUR_MS, gearItem, isGearSlot, isRecord, type GearSlot } from './catalog.ts'

export type JournalEntry =
  /** Joined the camp */
  | { kind: 'hired'; at: number }
  /** Came back from a session of ≥ 1 whole minute: how long, where (the project's name; the worktree's branch, folder or "Global"), with which agent, and the wood credited on it */
  | { kind: 'trip'; at: number; minutes: number; project: string; place: string; provider: string; wood: number }
  /** Out on a session in the worktree of a pull request that merged */
  | { kind: 'summit'; at: number; branch: string; project: string }
  | { kind: 'level'; at: number; level: number; title: string }
  | { kind: 'gear'; at: number; slot: GearSlot; tier: number }
  /** Pinned to a session type or an agent, by its name then */
  | { kind: 'pinned'; at: number; name: string }
  | { kind: 'unpinned'; at: number; name: string }
  /** Its session's agent posted a trail report (part 5): the trail's branch and the summary */
  | { kind: 'report'; at: number; branch: string; summary: string }

export const JOURNAL_MAX = 40

const PROVIDER_NAMES: Readonly<Record<string, string>> = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini', grok: 'Grok' }
/** An agent's name: the built-in ones by name, any other by its id with a capital */
export const providerName = (id: string): string => (Object.hasOwn(PROVIDER_NAMES, id) ? PROVIDER_NAMES[id] : id.charAt(0).toUpperCase() + id.slice(1))

/** The longest name a journal keeps (a project, a place, a branch) */
const NAME_MAX = 80
const cut = (s: string): string => (s.length > NAME_MAX ? s.slice(0, NAME_MAX) : s)

/** Adds an entry (its names cut to NAME_MAX), dropping the oldest past JOURNAL_MAX */
export function note(member: { journal: JournalEntry[] }, entry: JournalEntry): void {
  if (entry.kind === 'trip') entry = { ...entry, project: cut(entry.project), place: cut(entry.place) }
  else if (entry.kind === 'summit') entry = { ...entry, branch: cut(entry.branch), project: cut(entry.project) }
  else if (entry.kind === 'report') entry = { ...entry, branch: cut(entry.branch) }
  member.journal.push(entry)
  if (member.journal.length > JOURNAL_MAX) member.journal.splice(0, member.journal.length - JOURNAL_MAX)
}

const num = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x)
const str = (x: unknown): x is string => typeof x === 'string'

/** Whether camp.json held a journal entry this version can read: a known kind with its fields */
export function isEntry(x: unknown): x is JournalEntry {
  if (!isRecord(x) || !num(x.at)) return false
  switch (x.kind) {
    case 'hired':
      return true
    case 'trip':
      return num(x.minutes) && x.minutes >= 0 && str(x.project) && str(x.place) && str(x.provider) && num(x.wood)
    case 'summit':
      return str(x.branch) && str(x.project)
    case 'level':
      return num(x.level) && str(x.title)
    case 'gear':
      return isGearSlot(x.slot) && Number.isInteger(x.tier) && (x.tier as number) >= 1 && (x.tier as number) <= GEAR_TOP
    case 'pinned':
    case 'unpinned':
      return str(x.name)
    case 'report':
      return str(x.branch) && str(x.summary)
    default:
      return false
  }
}

/** Minutes as "3 h 12 m", "45 m" or "2 h" (rounded to whole minutes, never below 0) */
export function duration(minutes: number): string {
  const whole = Math.max(0, Math.round(minutes))
  const h = Math.floor(whole / 60)
  const m = whole % 60
  if (h === 0) return `${m} m`
  return m === 0 ? `${h} h` : `${h} h ${m} m`
}

/** How long ago `at` was: "just now", "5 m ago", "2 h ago", "3 d ago" */
export function ago(at: number, now: number): string {
  const minutes = Math.floor((now - at) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} m ago`
  const hours = Math.floor((now - at) / HOUR_MS)
  return hours < 24 ? `${hours} h ago` : `${Math.floor(hours / 24)} d ago`
}

/** An entry's line */
export function entryText(e: JournalEntry): string {
  switch (e.kind) {
    case 'hired':
      return 'Joined the camp'
    case 'trip':
      return `${duration(e.minutes)} on ${e.place} in ${e.project}${e.provider ? ` with ${providerName(e.provider)}` : ''}${e.wood > 0 ? ` · 🪵 ${e.wood}` : ''}`
    case 'summit':
      return `Summited ${e.branch} in ${e.project}`
    case 'level':
      return `Reached Lv ${e.level} ${e.title}`
    case 'gear':
      return `Bought ${gearItem(e.slot, e.tier).phrase}`
    case 'pinned':
      return `Pinned to ${e.name} sessions`
    case 'unpinned':
      return `Unpinned from ${e.name} sessions`
    case 'report':
      return `Reported on ${e.branch}: ${e.summary}`
  }
}

/**
 * A member's journal for its view: newest first, each with its line and how long ago. Its key is
 * "<at>:<kind>", which stays with the entry as the oldest are dropped; one alike an older entry adds
 * its place (":<index>").
 */
export function journalLines(journal: readonly JournalEntry[], now: number): { key: string; text: string; when: string }[] {
  const seen = new Set<string>()
  return journal
    .map((e, i) => {
      const base = `${e.at}:${e.kind}`
      const key = seen.has(base) ? `${base}:${i}` : base
      seen.add(base)
      return { key, text: entryText(e), when: ago(e.at, now) }
    })
    .reverse()
}
