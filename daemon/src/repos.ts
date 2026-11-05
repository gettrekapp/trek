import { execFileSync } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import type { RemoteRepo } from '../../src/shared/protocol'
import type { DaemonConfig } from './config'

/**
 * Resolves `path` to the top level of the git checkout containing it, so
 * `trek-daemon add` works from any subdirectory. Throws with a user-facing
 * message when the path is missing or not in a repo.
 */
export function resolveRepoRoot(path: string): string {
  const abs = resolve(path)
  if (!existsSync(abs)) throw new Error(`${abs} does not exist`)
  let top: string
  try {
    top = execFileSync('git', ['-C', abs, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim()
  } catch {
    throw new Error(`${abs} is not inside a git repository`)
  }
  return realpathSync(top)
}

/** Hand-written config paths may be relative or symlinked. */
function realOrResolved(path: string): string {
  try {
    return realpathSync(resolve(path))
  } catch {
    return resolve(path)
  }
}

function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'repo'
}

export interface AddRepoOptions {
  id?: string
  name?: string
}

/**
 * Adds the repo at `path` (already resolved by resolveRepoRoot) to `config`.
 * A path that is already configured is left alone and returned with
 * `added: false`. A derived id that clashes gets a numeric suffix; an
 * explicit one that clashes is an error.
 */
export function addRepo(
  config: DaemonConfig,
  path: string,
  options: AddRepoOptions = {}
): { repo: RemoteRepo; added: boolean } {
  const existing = config.repos.find((r) => realOrResolved(r.path) === path)
  if (existing) return { repo: existing, added: false }

  const taken = new Set(config.repos.map((r) => r.id))
  let id: string
  if (options.id !== undefined) {
    if (taken.has(options.id)) throw new Error(`Repo id "${options.id}" is already used`)
    id = options.id
  } else {
    const base = slugify(basename(path))
    id = base
    for (let n = 2; taken.has(id); n++) id = `${base}-${n}`
  }

  const repo: RemoteRepo = { id, name: options.name ?? basename(path), path }
  config.repos.push(repo)
  return { repo, added: true }
}
