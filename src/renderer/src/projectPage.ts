// The project-level pages the left panel opens over the worktree detail. Pure: the store applies it.

export type ProjectPage = 'settings' | 'automations'

/** The page open after its row is clicked: the open page's own row closes it. */
export function nextProjectPage(current: ProjectPage | null, clicked: ProjectPage): ProjectPage | null {
  return current === clicked ? null : clicked
}
