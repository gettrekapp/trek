// A branch's pull request watch and a worktree's notice on the phone: whether the Branch section
// offers the switch, what it and the pull request's label say, a notice's line and age, and which
// Attention items can be dismissed. The rules are the desktop's (WorktreeDetail.tsx: watchingPr,
// the chip's " · watching", the menu's item) and the server's (prWatch/prWatchHandlers.ts). Pure.
import { prOwner, type AttentionEntry, type BranchData, type PrNotice, type PrProvider } from '../shared.ts'
import { ago } from './attention.ts'

type Watched = Pick<BranchData, 'pr' | 'prWatch'> | undefined

/**
 * Whether the server watches the branch's pull request: the branch's data (`branchData[branch]` in
 * the snapshot; undefined for none) has a `pr` and a `prWatch` (`{}` until its first poll).
 */
export function isWatching(data: Watched): boolean {
  return !!data?.pr && !!data.prWatch
}

/**
 * Whether the pull request row offers the switch: a pull request is linked, and either the server
 * already watches it (so a watch can be stopped while signed out, or with its provider off), or a
 * provider on for the project (`providers`) owns the link and the server can watch (`capable`: its
 * welcome lists the `prWatch` capability now, which follows its host's sign-in).
 */
export function watchOffered(data: Watched, capable: boolean, providers: readonly PrProvider[]): boolean {
  if (!data?.pr) return false
  return isWatching(data) || (capable && !!prOwner(providers, data.pr))
}

/**
 * What follows the pull request's label ("PR #42 · watching"): nothing when not watched; a watch
 * the server keeps but cannot poll while its host's sign-in is missing says so, naming the sign-in
 * of the provider that owns the link (`providers`: those on for the project).
 */
export function watchSuffix(data: Watched, capable: boolean, providers: readonly PrProvider[]): string {
  if (!isWatching(data)) return ''
  if (capable) return ' · watching'
  const name = (data?.pr && prOwner(providers, data.pr)?.signInName) || 'its host'
  return ` · watch paused, ${name} isn't signed in`
}

/** The switch: its label, and the `watch` its tap sends with `branch.setPrWatch` (`{projectId, repoId, branch, watch}`). */
export function watchAction(data: Watched): { label: 'Watch' | 'Stop watching'; watch: boolean } {
  return isWatching(data) ? { label: 'Stop watching', watch: false } : { label: 'Watch', watch: true }
}

/** A notice on the worktree's card, one line without buttons: "PR #12: Checks failed: build". */
export function noticeLine(notice: PrNotice): string {
  return `${notice.title}: ${notice.text}`.replace(/\s+/g, ' ').trim()
}

/** How long ago a notice was raised ("3 min ago"); "just now" when the server's clock is ahead of the phone's. */
export function noticeAge(notice: Pick<PrNotice, 'at'>, now: number): string {
  return ago(notice.at, now)
}

/**
 * `prWatch.dismiss`'s params for an Attention item, or null when it has no Dismiss: only a
 * worktree's pull request notice has one (the entry's `pullRequest`; its `sessionId` is '').
 */
export function noticeDismissal(entry: Pick<AttentionEntry, 'projectId' | 'worktreeId' | 'pullRequest'>): { projectId: string; worktreeId: string } | null {
  return entry.pullRequest && entry.worktreeId ? { projectId: entry.projectId, worktreeId: entry.worktreeId } : null
}
