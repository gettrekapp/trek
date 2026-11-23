// A crew member's trail journal (campsite part 3b): what it did, as data (the words are made where
// it is shown, so they can change). Newest last, at most JOURNAL_MAX. Pure.
import type { GearSlot } from './catalog.ts'

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

export const JOURNAL_MAX = 40

const PROVIDER_NAMES: Readonly<Record<string, string>> = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini', grok: 'Grok' }
/** An agent's name: the built-in ones by name, any other by its id with a capital */
export const providerName = (id: string): string => (Object.hasOwn(PROVIDER_NAMES, id) ? PROVIDER_NAMES[id] : id.charAt(0).toUpperCase() + id.slice(1))

/** Adds an entry, dropping the oldest past JOURNAL_MAX */
export function note(member: { journal: JournalEntry[] }, entry: JournalEntry): void {
  member.journal.push(entry)
  if (member.journal.length > JOURNAL_MAX) member.journal.splice(0, member.journal.length - JOURNAL_MAX)
}
