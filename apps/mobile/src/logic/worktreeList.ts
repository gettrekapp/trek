// What the project screen's worktree list says about a branch (its workflow tag, custom tags,
// ticket and pull request on one line), which worktree a branch is checked out in (the Add
// worktree screen's "the PR's branch already has a worktree"), and a repository's folder name. Pure.
import { DEFAULT_WORKTREE_TAGS, type ProjectSettings, type Repository, type TicketProvider, type Worktree } from '../shared.ts'
import { ticketView } from './tickets.ts'
import { pullRequestLabel } from './worktrees.ts'

/** One piece of a branch's line; a tag carries the colour the user gave it. */
export interface BranchPart {
  text: string
  color?: string
}

/**
 * A branch's line on its worktree's row, in pieces: the workflow tag's name, the custom tags' names
 * (in the project's order), the ticket's label and "PR #<n>", each when present; none otherwise. A
 * tag the project no longer has is left out. A project that never set its tags has the default
 * ones, as on the desktop.
 */
export function branchParts(settings: ProjectSettings, repo: Pick<Repository, 'branchData'>, branch: string | undefined, providers: readonly TicketProvider[]): BranchPart[] {
  const data = branch !== undefined && Object.hasOwn(repo.branchData, branch) ? repo.branchData[branch] : undefined
  if (!data) return []
  const parts: BranchPart[] = []
  const tag = data.tag ? (settings.worktreeTags ?? DEFAULT_WORKTREE_TAGS).find((t) => t.id === data.tag) : undefined
  if (tag) parts.push({ text: tag.name, color: tag.color })
  for (const custom of settings.customTags ?? []) if (data.customTags?.includes(custom.id)) parts.push({ text: custom.name, color: custom.color })
  if (data.ticket) parts.push({ text: ticketView(providers, settings, data.ticket).label })
  if (data.pr) {
    // "#42", or "PR" for a link without a number.
    const label = pullRequestLabel(data.pr)
    parts.push({ text: label.startsWith('#') ? `PR ${label}` : label })
  }
  return parts
}

/** The same line as one string ('' with none). */
export function branchLine(settings: ProjectSettings, repo: Pick<Repository, 'branchData'>, branch: string | undefined, providers: readonly TicketProvider[]): string {
  return branchParts(settings, repo, branch, providers)
    .map((p) => p.text)
    .join(' · ')
}

/** The worktree `branch` is checked out in. A missing one does not count: git no longer has it there. */
export function worktreeOnBranch<W extends Pick<Worktree, 'branch' | 'missing'>>(repo: { worktrees: readonly W[] }, branch: string): W | undefined {
  return repo.worktrees.find((w) => w.branch === branch && !w.missing)
}

/** The last part of a repository's path on its server (either kind of separator). */
export function repoFolder(path: string): string {
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path
}
