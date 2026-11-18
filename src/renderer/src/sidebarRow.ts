// What a sidebar row says beyond its name: its git marks, the reason that takes over
// its second line, and the pieces of the hover card that carries what the row no longer spells out.

export interface RowGit {
  /** "↑2 ↓1" — empty when the branch is level with its upstream */
  counts: string
  dirty: boolean
}

/** null when there is nothing to mark: clean, level, or not yet known. */
export function rowGit(info: { ahead?: number; behind?: number; dirty?: boolean }): RowGit | null {
  const bits: string[] = []
  if (info.ahead) bits.push(`↑${info.ahead}`)
  if (info.behind) bits.push(`↓${info.behind}`)
  const dirty = !!info.dirty
  return bits.length || dirty ? { counts: bits.join(' '), dirty } : null
}

export interface RowReason {
  kind: 'missing' | 'decision' | 'notice'
  text: string
  title: string
}

/**
 * Why the row wants the user, shown in place of its tag/ticket/PR line. A missing worktree
 * can only be deleted, so it comes first; a decision blocks an agent, so it outranks a notice.
 */
export function rowReason(input: {
  missing: boolean
  /** One per open decision; a decision may come without its question */
  questions: (string | undefined)[]
  prNotice?: string
  /** pullRequestLabel(): "#123", or "PR" when the number is not parseable */
  prLabel?: string
}): RowReason | null {
  if (input.missing) {
    return {
      kind: 'missing',
      text: 'Missing on the server · delete to drop',
      title: 'Git no longer lists this worktree on the server; delete it to drop it'
    }
  }
  if (input.questions.length > 0) {
    const asked = input.questions.filter((q): q is string => !!q)
    const more = input.questions.length - 1
    return {
      kind: 'decision',
      text: asked.length ? `Decision: ${asked[0]}${more > 0 ? ` (+${more})` : ''}` : 'Needs a decision',
      title: ['Needs a decision:', ...asked].join('\n')
    }
  }
  if (input.prNotice) {
    const pr = input.prLabel?.startsWith('#') ? `PR ${input.prLabel}` : 'PR'
    return { kind: 'notice', text: `${pr} · ${input.prNotice}`, title: input.prNotice }
  }
  return null
}

/** The sidebar's dot shapes: a worktree row's, and one per session in its hover card. */
export type DotKind = 'none' | 'dormant' | 'idle' | 'running' | 'attention' | 'done' | 'exited'

type SessionStatus = 'starting' | 'working' | 'attention' | 'done' | 'complete' | 'idle' | 'exited'

/** One session in the hover card: its dot and the word beside its title. */
export function sessionLine(status: SessionStatus): { dot: DotKind; word: string } {
  switch (status) {
    case 'starting':
      return { dot: 'running', word: 'starting' }
    case 'working':
      return { dot: 'running', word: 'working' }
    case 'attention':
      return { dot: 'attention', word: 'needs you' }
    case 'done':
      return { dot: 'done', word: 'finished' }
    case 'complete':
      return { dot: 'idle', word: 'complete' }
    case 'exited':
      return { dot: 'exited', word: 'exited' }
    default:
      return { dot: 'idle', word: 'idle' }
  }
}

/** The row's git marks in words, for the hover card. Empty when there is nothing to say. */
export function gitWords(info: { ahead?: number; behind?: number; dirty?: boolean }): string {
  const bits: string[] = []
  if (info.dirty) bits.push('Uncommitted changes')
  if (info.ahead) bits.push(`${info.ahead} ahead`)
  if (info.behind) bits.push(`${info.behind} behind`)
  return bits.join(' · ')
}

const CARD_GAP = 8

/**
 * Where the hover card sits (fixed position): beside the row, hanging from its top — or, for a
 * row in the lower part of the window, standing on its bottom so the card grows upward.
 */
export function cardAnchor(
  row: { top: number; bottom: number; right: number },
  viewportHeight: number
): { left: number; top: number } | { left: number; bottom: number } {
  const left = row.right + CARD_GAP
  if (row.top > viewportHeight * 0.55) return { left, bottom: Math.max(CARD_GAP, viewportHeight - row.bottom) }
  return { left, top: Math.max(CARD_GAP, row.top) }
}

/** How the sidebar lists its rows: the Sort menu's choices, kept per window in localStorage. */
export type SidebarSort = 'manual' | 'alphabetical' | 'attention'

const SIDEBAR_SORTS: SidebarSort[] = ['manual', 'alphabetical', 'attention']

export interface SidebarView {
  /** 'manual' is the dragged order; 'alphabetical' is by branch name; 'attention' groups each repository's rows by who needs you */
  sort: SidebarSort
  /** One-line rows; a row that needs you keeps its second line */
  compact: boolean
  /** Leave out rows with no loaded session (the selected row always stays) */
  hideUnloaded: boolean
}

export const DEFAULT_SIDEBAR_VIEW: SidebarView = { sort: 'manual', compact: false, hideUnloaded: false }

/** The stored view, tolerant of a missing, corrupt or older value. */
export function parseSidebarView(raw: string | null | undefined): SidebarView {
  if (!raw) return DEFAULT_SIDEBAR_VIEW
  try {
    const v = JSON.parse(raw) as Partial<Record<keyof SidebarView, unknown>> | null
    if (!v || typeof v !== 'object') return DEFAULT_SIDEBAR_VIEW
    return { sort: SIDEBAR_SORTS.includes(v.sort as SidebarSort) ? (v.sort as SidebarSort) : 'manual', compact: v.compact === true, hideUnloaded: v.hideUnloaded === true }
  } catch {
    return DEFAULT_SIDEBAR_VIEW
  }
}

/** True when the view differs from the default, so the Sort button can say so. */
export function sidebarViewChanged(view: SidebarView): boolean {
  return view.sort !== 'manual' || view.compact || view.hideUnloaded
}

/** Branch labels A→Z for the Alphabetical sort: case-insensitive, with numbers in number order (fix-2 before fix-10). */
export function compareLabels(a: string, b: string): number {
  return a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true }) || a.localeCompare(b)
}

/** No session is loaded: nothing running, with or without saved sessions. */
export function isUnloaded(dot: DotKind): boolean {
  return dot === 'none' || dot === 'dormant'
}

export type AttentionGroup = 'needs' | 'working' | 'quiet'

export const ATTENTION_GROUP_LABELS: Record<AttentionGroup, string> = {
  needs: 'Needs you',
  working: 'Working',
  quiet: 'Quiet'
}

/** Which "Attention first" group a row is in: it wants you, an agent is busy, or neither. */
export function attentionGroup(dot: DotKind, reason: RowReason['kind'] | undefined): AttentionGroup {
  if (dot === 'attention' || dot === 'done' || reason === 'decision' || reason === 'notice') return 'needs'
  return dot === 'running' ? 'working' : 'quiet'
}

/** Rows split into the attention groups, in that order, each keeping the rows' own order; empty groups are left out. */
export function groupByAttention<T>(rows: T[], groupOf: (row: T) => AttentionGroup): { group: AttentionGroup; rows: T[] }[] {
  const order: AttentionGroup[] = ['needs', 'working', 'quiet']
  return order
    .map((group) => ({ group, rows: rows.filter((row) => groupOf(row) === group) }))
    .filter((g) => g.rows.length > 0)
}

/** The filter box: a row matches when any of its texts (name, path, repository, ticket, PR) holds the query. */
export function rowMatchesQuery(query: string, fields: (string | undefined)[]): boolean {
  const q = query.trim().toLowerCase()
  return !q || fields.some((f) => !!f && f.toLowerCase().includes(q))
}
