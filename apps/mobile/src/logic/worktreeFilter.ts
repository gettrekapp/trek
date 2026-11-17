// The worktree list's tag filter (the project screen and the tablet sidebar), as the desktop
// sidebar's "Tag" menu (src/renderer/src/components/Sidebar.tsx): a set of the project's workflow
// and custom tag ids, and Untagged; a worktree shows when it matches any of them, every one when
// the set is empty. Pure.
import { DEFAULT_WORKTREE_TAGS, type ProjectSettings, type Repository, type Worktree, type WorktreeTag } from '../shared.ts'

/** The filter's id for worktrees whose branch has no workflow tag (the project's). */
export const UNTAGGED = 'untagged'

type Tags = Pick<ProjectSettings, 'worktreeTags' | 'customTags'>

/** The sheet's tags: the workflow ones (the defaults for a project that never set them), then the custom ones. */
export function tagFilterOptions(settings: Tags): { workflow: readonly WorktreeTag[]; custom: readonly WorktreeTag[] } {
  return { workflow: settings.worktreeTags ?? DEFAULT_WORKTREE_TAGS, custom: settings.customTags ?? [] }
}

/** Whether the worktree's branch matches any id of `filter` (an empty filter matches every worktree). */
export function matchesTagFilter(settings: Tags, repo: Pick<Repository, 'branchData'>, worktree: Pick<Worktree, 'branch'>, filter: readonly string[]): boolean {
  if (filter.length === 0) return true
  const { workflow, custom } = tagFilterOptions(settings)
  const branch = worktree.branch
  const data = branch !== undefined && Object.hasOwn(repo.branchData, branch) ? repo.branchData[branch] : undefined
  const tag = data?.tag && workflow.some((t) => t.id === data.tag) ? data.tag : undefined
  const customs = (data?.customTags ?? []).filter((id) => custom.some((t) => t.id === id))
  return filter.some((id) => (id === UNTAGGED ? !tag : id === tag || customs.includes(id)))
}

/** The filter without ids of tags the project no longer has (Untagged always stays). */
export function cleanTagFilter(settings: Tags, filter: readonly string[]): string[] {
  const { workflow, custom } = tagFilterOptions(settings)
  return filter.filter((id) => id === UNTAGGED || workflow.some((t) => t.id === id) || custom.some((t) => t.id === id))
}

/** The filter with `id` picked, or unpicked when it was. */
export function toggledTagFilter(filter: readonly string[], id: string): string[] {
  return filter.includes(id) ? filter.filter((x) => x !== id) : [...filter, id]
}

/** The chip's text ("Tag: All", the tag's name, "Tag: Untagged", "Tag: 3 tags") and the picked tags' colours. Expects a cleaned filter. */
export function tagFilterLabel(settings: Tags, filter: readonly string[]): { text: string; colors: string[] } {
  const { workflow, custom } = tagFilterOptions(settings)
  const picked = [...workflow, ...custom].filter((t) => filter.includes(t.id))
  const colors = picked.map((t) => t.color)
  if (filter.length === 0) return { text: 'Tag: All', colors }
  if (filter.length > 1) return { text: `Tag: ${filter.length} tags`, colors }
  return { text: filter[0] === UNTAGGED ? 'Tag: Untagged' : `Tag: ${picked[0]?.name ?? ''}`, colors }
}
