// Keys used inside the v2 model. No runtime imports.

/** Entry of ProjectSettings.worktreeOrder: a worktree's repository id and path. Repository ids never contain a space. */
export function worktreeOrderKey(repoId: string, path: string): string {
  return `${repoId} ${path}`
}
