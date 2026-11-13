import { dirname, resolve } from 'node:path'
import type { TrekServerConfig } from './config'
import { isInside, isUncPath, realPath, UNC_REFUSAL } from '../../src/host/pathContainment.ts'

export interface PathGuardOptions {
  /** Every path is allowed (`trek-server start --local` only) */
  permissive?: boolean
  /** The platform UNC paths are refused on (Windows only); tests give it */
  platform?: NodeJS.Platform
  /** The real path, as pathContainment's realPath (tests give a Windows-like one) */
  realPath?: (path: string) => string
}

function uncDenied(path: string): Error {
  const err = new Error(`${UNC_REFUSAL}: ${path}`)
  ;(err as NodeJS.ErrnoException).code = 'PATH_DENIED'
  return err
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
  private readonly platform: NodeJS.Platform
  private readonly realPath: (path: string) => string

  constructor(config: TrekServerConfig, options: PathGuardOptions = {}) {
    this.permissive = options.permissive === true
    this.platform = options.platform ?? process.platform
    this.realPath = options.realPath ?? ((path) => realPath(path))
    const roots = new Set<string>()
    const addRoot = (path: string): void => {
      // realpath so symlinked configs (e.g. /var → /private/var) match the
      // realpath'd targets checked later.
      try {
        roots.add(this.realPath(resolve(path)))
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

  /**
   * Windows: throws PATH_DENIED for a UNC path, as given or as it resolves (a mapped drive, a
   * junction or symlink onto a share). Network and WSL shares: git and file watching over them
   * are slow and unreliable, and an agent would run on the Windows side of a WSL repo. Every
   * check() does this, permissive or not; `trek-server add` calls it directly. Elsewhere a no-op.
   */
  assertLocal(path: string): void {
    if (this.platform !== 'win32') return
    if (isUncPath(path)) throw uncDenied(path)
    let real: string
    try {
      real = this.realPath(resolve(path))
    } catch {
      return // missing: check() resolves its deepest existing ancestor
    }
    if (isUncPath(real)) throw uncDenied(path)
  }

  /** Returns the resolved path, or throws { code: 'PATH_DENIED' } (never when permissive, but for a UNC path on Windows). */
  check(path: string): string {
    if (this.platform === 'win32' && isUncPath(path)) throw uncDenied(path)
    let resolved: string
    try {
      resolved = this.realPath(resolve(path))
    } catch {
      // Target may not exist yet (e.g. a worktree about to be created) —
      // resolve the deepest existing ancestor instead.
      resolved = resolve(path)
      let probe = dirname(resolved)
      while (probe !== dirname(probe)) {
        try {
          const real = this.realPath(probe)
          resolved = real + resolved.slice(probe.length)
          break
        } catch {
          probe = dirname(probe)
        }
      }
    }
    if (this.platform === 'win32' && isUncPath(resolved)) throw uncDenied(path)
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
