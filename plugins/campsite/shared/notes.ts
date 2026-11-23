// Agents in the camp (campsite part 5): a project's noticeboard notes (the camp_note MCP tool) and a
// trail's report (camp_trail_report), as data. Agent-written text is cleaned (one line, trimmed,
// control characters gone) and measured in code points; each project keeps its newest NOTES_MAX
// notes. A post is allowed once a minute per key (a session, a project, a trail). Pure.
import { isRecord } from './catalog.ts'
import { providerName } from './journal.ts'
import type { ShopRefusal } from './shop.ts'

/** A note's longest text, and a report's (code points, after cleanup) */
export const NOTE_MAX = 140
export const REPORT_MAX = 280
/** The notes each project keeps (the newest) */
export const NOTES_MAX = 20
/** One post per key in this long */
export const POST_EVERY_MS = 60_000

/** A note on a project's noticeboard: who left it (the session's agent, its worktree's branch or "Global", its crew member), when known */
export interface Note {
  id: string
  text: string
  at: number
  /** The session's agent (its provider's id) */
  agent?: string
  /** The session's worktree's branch (or folder), or "Global" */
  branch?: string
  /** The session's crew member's name */
  member?: string
}

/** A trail's latest report: its summary, when, and who posted it ("Claude · Juniper") */
export interface TrailReport {
  summary: string
  at: number
  by?: string
}

const num = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x)
const optStr = (x: unknown): boolean => x === undefined || typeof x === 'string'

/** Who posted: the agent's name and the crew member's ("Claude · Juniper"), either alone, or '' when neither is known */
export const whoLine = (agent: string | undefined, member: string | undefined): string => [agent ? providerName(agent) : '', member ?? ''].filter(Boolean).join(' · ')

/** Code points, not UTF-16 units: an emoji is one */
export const textLength = (s: string): number => [...s].length

/**
 * What becomes a space in an agent's text: C0 and C1 control characters, the line and paragraph
 * separators, and the invisible ones that could hide or reorder what is shown (zero-width spaces and
 * joiners, the bidi marks, embeddings, overrides and isolates, the word joiner, the BOM)
 */
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g

/**
 * An agent's text as the camp keeps it: one line (control and invisible characters and line breaks
 * become spaces, runs of white space one space), trimmed, 1 to `max` code points; else why not.
 */
export function cleanText(value: unknown, max: number, what: 'note' | 'summary'): string | ShopRefusal {
  if (typeof value !== 'string') return { code: 'BAD_REQUEST', message: `The ${what} must be a string.` }
  const text = value.replace(INVISIBLE, ' ').replace(/\s+/g, ' ').trim()
  if (text === '') return { code: 'BAD_REQUEST', message: `The ${what} is empty.` }
  const n = textLength(text)
  if (n > max) return { code: 'BAD_REQUEST', message: `The ${what} is too long: ${n} characters (at most ${max}).` }
  return text
}

/** A note this version can read */
export const isNote = (x: unknown): x is Note =>
  isRecord(x) && typeof x.id === 'string' && typeof x.text === 'string' && num(x.at) && optStr(x.agent) && optStr(x.branch) && optStr(x.member)

/** A report this version can read */
export const isReport = (x: unknown): x is TrailReport => isRecord(x) && typeof x.summary === 'string' && num(x.at) && optStr(x.by)

/** Drops what camp.json held under `notes` that this version can't read: not a map (it becomes {}), a project's list that isn't one, notes; past NOTES_MAX, the oldest */
export function dropBadNotes(camp: { notes: unknown }): void {
  if (!isRecord(camp.notes)) {
    camp.notes = {}
    return
  }
  const notes = camp.notes
  for (const [projectId, list] of Object.entries(notes)) {
    if (!Array.isArray(list)) delete notes[projectId]
    else notes[projectId] = list.filter(isNote).slice(-NOTES_MAX)
  }
}

/** Pins a note on a project's board (newest last; the oldest past NOTES_MAX go); its id is its time, with a count when another note has it */
export function addNote(camp: { notes: Record<string, Note[]> }, projectId: string, note: Omit<Note, 'id'>): Note {
  const list = Object.hasOwn(camp.notes, projectId) ? camp.notes[projectId] : (camp.notes[projectId] = [])
  const base = String(note.at)
  let id = base
  for (let k = 2; list.some((n) => n.id === id); k++) id = `${base}-${k}`
  const pinned: Note = { id, ...note }
  list.push(pinned)
  if (list.length > NOTES_MAX) list.splice(0, list.length - NOTES_MAX)
  return pinned
}

/** Each project's newest note's time (the snapshot's `noteAt`): the boards and their unread dots */
export function noteAtOf(camp: { notes: Record<string, Note[]> }): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [projectId, list] of Object.entries(camp.notes)) {
    const last = list.at(-1)
    if (last) out[projectId] = last.at
  }
  return out
}

/** `notes { projectId }`: that project's notes, oldest first (copies; none for a project the camp doesn't know) */
export function notesOf(camp: { notes: Record<string, Note[]> }, params: Record<string, unknown>): ShopRefusal | { notes: Note[] } {
  const { projectId } = params
  if (typeof projectId !== 'string') return { code: 'BAD_REQUEST', message: 'Notes need { projectId }' }
  const list = Object.hasOwn(camp.notes, projectId) ? camp.notes[projectId] : []
  return { notes: list.map((n) => ({ ...n })) }
}

/**
 * One post a minute per key: true (and the post's time kept) when `key`'s last post is POST_EVERY_MS
 * old or more, else false. Keys a minute old or more are let go first.
 */
export function takePost(last: Map<string, number>, key: string, now: number): boolean {
  for (const [k, at] of last) if (now - at >= POST_EVERY_MS) last.delete(k)
  if (last.has(key)) return false
  last.set(key, now)
  return true
}
