// A worktree's row on the project screen, as on the desktop's sidebar: one mark for its sessions,
// its git marks, and a second line that is its branch's tag, ticket and pull request — or, when
// the row wants the user, the reason. Pure.
import type { Session, Worktree } from '../shared.ts'
import { noticeLine } from './prWatch.ts'

/** The row's one mark: the most pressing of its sessions' states. 'none' has no loaded session. */
export type RowMark = 'attention' | 'done' | 'working' | 'idle' | 'none'

export function rowMark(worktree: Pick<Worktree, 'loaded'> & { sessions: readonly Pick<Session, 'status' | 'decision'>[] }): RowMark {
  if (!worktree.loaded || worktree.sessions.length === 0) return 'none'
  const has = (status: Session['status']): boolean => worktree.sessions.some((s) => s.status === status)
  if (has('attention') || worktree.sessions.some((s) => !!s.decision)) return 'attention'
  if (has('done')) return 'done'
  if (has('working')) return 'working'
  return 'idle'
}

/** One session's mark, for a list of sessions. */
export function sessionMark(session: Pick<Session, 'status' | 'decision'>): RowMark {
  return rowMark({ loaded: true, sessions: [session] })
}

/** "↑2 ↓1" and whether there are uncommitted changes; null when clean, level, or not yet known. */
export function rowGit(worktree: Pick<Worktree, 'ahead' | 'behind' | 'dirty'>): { counts: string; dirty: boolean } | null {
  const bits: string[] = []
  if (worktree.ahead) bits.push(`↑${worktree.ahead}`)
  if (worktree.behind) bits.push(`↓${worktree.behind}`)
  const dirty = !!worktree.dirty
  return bits.length || dirty ? { counts: bits.join(' '), dirty } : null
}

/** How many sessions an unloaded worktree has saved (the row's "▸2"); 0 for a loaded one. */
export function rowSaved(worktree: Pick<Worktree, 'loaded'> & { sessions: readonly unknown[] }): number {
  return worktree.loaded ? 0 : worktree.sessions.length
}

export interface RowReason {
  kind: 'missing' | 'decision' | 'notice'
  text: string
}

/**
 * Why the row wants the user, in place of its tag, ticket and pull request. A missing worktree can
 * only be removed, so it comes first; a decision blocks an agent, so it outranks a notice.
 */
export function rowReason(worktree: Pick<Worktree, 'missing' | 'prNotice'> & { sessions: readonly Pick<Session, 'decision'>[] }): RowReason | null {
  if (worktree.missing) return { kind: 'missing', text: 'Missing on the server' }
  const questions = worktree.sessions.filter((s) => !!s.decision).map((s) => s.decision?.question)
  if (questions.length > 0) {
    const first = questions.find((q) => !!q)
    const more = questions.length - 1
    return { kind: 'decision', text: first ? `Decision: ${first}${more > 0 ? ` (+${more})` : ''}` : 'Needs a decision' }
  }
  if (worktree.prNotice) return { kind: 'notice', text: noticeLine(worktree.prNotice) }
  return null
}

/** What a screen reader says for the row: its name, state, git marks and second line. */
export function rowLabel(input: { name: string; isMain: boolean; mark: RowMark; saved: number; git: { counts: string; dirty: boolean } | null; line: string }): string {
  const state: Record<RowMark, string> = { attention: 'needs you', done: 'finished', working: 'working', idle: 'idle', none: input.saved ? `${input.saved} saved session${input.saved === 1 ? '' : 's'}` : 'no sessions' }
  const parts = [input.isMain ? `${input.name}, main checkout` : input.name, state[input.mark]]
  if (input.git?.dirty) parts.push('uncommitted changes')
  if (input.git?.counts) parts.push(input.git.counts.replace('↑', 'ahead ').replace('↓', 'behind '))
  if (input.line) parts.push(input.line)
  return parts.join(', ')
}
