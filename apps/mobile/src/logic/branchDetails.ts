// The worktree screen's Branch section (ui/BranchDetails.tsx): the custom tags' toggle, the note's
// edit with its compare-and-set and what a conflict does to it, what a pull request box takes, which
// links are opened, and a tag chip's colours. The rules are the desktop's (backendV2.ts' branch
// setCustomTag and setNote) and the server's (v2.ts' setBranchField, validate.ts' checkExpected). Pure.
import { parsePullRequestUrl, pullRequestLabel } from './worktrees.ts'

/**
 * A branch's custom tags after `id` is tapped: taken out when on, added at the end when off; null
 * (which clears them) when none is left. Ids the project no longer has stay, as on the desktop.
 */
export function toggledCustomTags(current: readonly string[] | undefined, id: string): string[] | null {
  const without = (current ?? []).filter((t) => t !== id)
  const next = current?.includes(id) ? without : [...without, id]
  return next.length > 0 ? next : null
}

/** A note being edited. */
export interface NoteEdit {
  /** What the user typed */
  text: string
  /** The note the save is guarded by: as it was when editing began, or, after a conflict, the server's (the one shown); null for none */
  expected: string | null
  /** The server refused the last save: the note changed there meanwhile */
  conflict: boolean
}

/** The server takes no note as null: '' would not equal it, and leaving `expected` out is no check at all. */
const stored = (note: string | undefined | null): string | null => note || null

/** Editing begins from the snapshot's note. */
export function beginNoteEdit(note: string | undefined): NoteEdit {
  return { text: note ?? '', expected: stored(note), conflict: false }
}

/** branch.setNote's `note` and `expected` for a Save: the text as typed, or null (clears it) when it is empty or only blank. */
export function noteSave(edit: NoteEdit): { note: string | null; expected: string | null } {
  return { note: edit.text.trim() === '' ? null : edit.text, expected: edit.expected }
}

/**
 * The edit after the server refused its save: the user's text is kept, and the next save is
 * guarded by the server's note now (`current`, the snapshot's), which the section shows, so it
 * overwrites knowingly.
 */
export function noteConflicted(edit: NoteEdit, current: string | undefined): NoteEdit {
  return { text: edit.text, expected: stored(current), conflict: true }
}

/**
 * Whether a branch.setNote failure is the server's refusal of a note that changed meanwhile: a
 * CONFLICT (validate.ts' checkExpected: "branchData.note changed since you read it", no details).
 * It is the request's only CONFLICT.
 */
export function isNoteConflict(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { code?: unknown }).code === 'CONFLICT'
}

/** What a pull request box holds: the canonical link to save, why not, or null for nothing typed. */
export function pullRequestInput(input: string): { pr: string } | { error: string } | null {
  if (!input.trim()) return null
  const parsed = parsePullRequestUrl(input)
  return parsed ? { pr: parsed.url } : { error: 'Not a GitHub pull request link' }
}

/** "PR #42", or "PR" for a link without a number (as on the project screen's cards). */
export function pullRequestText(url: string): string {
  const label = pullRequestLabel(url)
  return label.startsWith('#') ? `PR ${label}` : label
}

/**
 * The link to open in the browser for a stored ticket or pull request link, or null: only http(s)
 * is opened. A branch's pull request is whatever was stored for it (the desktop, an agent's tool),
 * and a tap must not start another app's scheme.
 */
export function webLink(url: string | null | undefined): string | null {
  const link = url?.trim() ?? ''
  return /^https?:\/\/\S+$/i.test(link) ? link : null
}

const DARK_TEXT = '#11111b'
const LIGHT_TEXT = '#ffffff'
/** A chip for a tag whose colour is not a hex one (the theme's muted). */
const NEUTRAL_CHIP = '#9399b2'

/** WCAG relative luminance of #rrggbb. */
function luminance(hex: string): number {
  const channel = (at: number): number => {
    const c = parseInt(hex.slice(at, at + 2), 16) / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5)
}

/**
 * A selected tag chip: filled with the tag's colour (#rgb or #rrggbb, as #rrggbb), with the text
 * colour, dark or white, that contrasts more with it. Anything else is a neutral chip.
 */
export function chipColors(color: string | undefined): { fill: string; text: string } {
  const hex = (color ?? '').trim().toLowerCase()
  const fill = /^#[0-9a-f]{6}$/.test(hex) ? hex : /^#[0-9a-f]{3}$/.test(hex) ? `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}` : NEUTRAL_CHIP
  const l = luminance(fill)
  const onDark = (l + 0.05) / (luminance(DARK_TEXT) + 0.05)
  const onLight = 1.05 / (l + 0.05)
  return { fill, text: onDark >= onLight ? DARK_TEXT : LIGHT_TEXT }
}
