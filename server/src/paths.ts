import { dirname, resolve } from 'node:path'
import type { TrekServerConfig } from './config'
import { isInside, isUncPath, realPath, UNC_REFUSAL } from '../../src/host/pathContainment.ts'

export interface PathGuardOptions {
  /** Every path is allowed (`trek-server start --local` only) */
  permissive?: boolean
}

/**
 * Every client-supplied filesystem path must resolve under one of the
 * configured roots: a repo, a repo's parent directory (worktrees live as
 * siblings of the repo checkout), or an explicit worktreeRoot. This guards
 * against path typos and confused-deputy bugs — it is not a sandbox; the
 * token already grants shell access as the daemon user.
 *
 * The local server's guard is permissive: the user picks paths on their own
 * disk, so every path is allowed, and check() only resolves it.
 */
export class PathGuard {
  private roots: string[]
  private readonly permissive: boolean

  constructor(config: TrekServerConfig, options: PathGuardOptions = {}) {
    this.permissive = options.permissive === true
    const roots = new Set<string>()
    const addRoot = (path: string): void => {
      // realpath so symlinked configs (e.g. /var → /private/var) match the
      // realpath'd targets checked later.
      try {
        roots.add(realPath(resolve(path)))
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

  /** Returns the resolved path, or throws { code: 'PATH_DENIED' } (never when permissive). */
  check(path: string): string {
    // Network and WSL shares: git and file watching over them are slow and unreliable, and an
    // agent would run on the Windows side of a WSL repo. Refused even on the local server.
    if (process.platform === 'win32' && isUncPath(path)) {
      const err = new Error(`${UNC_REFUSAL}: ${path}`)
      ;(err as NodeJS.ErrnoException).code = 'PATH_DENIED'
      throw err
    }
    let resolved: string
    try {
      resolved = realPath(resolve(path))
    } catch {
      // Target may not exist yet (e.g. a worktree about to be created) —
      // resolve the deepest existing ancestor instead.
      resolved = resolve(path)
      let probe = dirname(resolved)
      while (probe !== dirname(probe)) {
        try {
          const real = realPath(probe)
          resolved = real + resolved.slice(probe.length)
          break
        } catch {
          probe = dirname(probe)
        }
      }
    }
    if (this.permissive) return resolved
    const allowed = this.roots.some((root) => isInside(root, resolved))
    if (!allowed) {
      const err = new Error(`Path not under a configured root: ${path}`)
      ;(err as NodeJS.ErrnoException).code = 'PATH_DENIED'
      throw err
    }
    return resolved
  }
}
