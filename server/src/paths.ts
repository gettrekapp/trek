import { realpathSync } from 'node:fs'
import { dirname, resolve, sep } from 'node:path'
import type { DaemonConfig } from './config'

/**
 * Every client-supplied filesystem path must resolve under one of the
 * configured roots: a repo, a repo's parent directory (worktrees live as
 * siblings of the repo checkout), or an explicit worktreeRoot. This guards
 * against path typos and confused-deputy bugs — it is not a sandbox; the
 * token already grants shell access as the daemon user.
 */
export class PathGuard {
  private roots: string[]

  constructor(config: DaemonConfig) {
    const roots = new Set<string>()
    const addRoot = (path: string): void => {
      // realpath so symlinked configs (e.g. /var → /private/var) match the
      // realpath'd targets checked later.
      try {
        roots.add(realpathSync(resolve(path)))
      } catch {
        roots.add(resolve(path))
      }
    }
    for (const repo of config.repos) {
      addRoot(repo.path)
      addRoot(dirname(resolve(repo.path)))
    }
    for (const root of config.worktreeRoots ?? []) addRoot(root)
    this.roots = [...roots]
  }

  /** Returns the resolved path, or throws { code: 'PATH_DENIED' }. */
  check(path: string): string {
    let resolved: string
    try {
      resolved = realpathSync(resolve(path))
    } catch {
      // Target may not exist yet (e.g. a worktree about to be created) —
      // resolve the deepest existing ancestor instead.
      resolved = resolve(path)
      let probe = dirname(resolved)
      while (probe !== dirname(probe)) {
        try {
          const real = realpathSync(probe)
          resolved = real + resolved.slice(probe.length)
          break
        } catch {
          probe = dirname(probe)
        }
      }
    }
    const allowed = this.roots.some(
      (root) => resolved === root || resolved.startsWith(root + sep)
    )
    if (!allowed) {
      const err = new Error(`Path not under a configured root: ${path}`)
      ;(err as NodeJS.ErrnoException).code = 'PATH_DENIED'
      throw err
    }
    return resolved
  }
}
