import { execFileSync } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import type { RemoteRepo } from '../../src/shared/protocolV2'
import type { TrekServerConfig } from './config'
import { hidden } from '../../src/host/childOptions.ts'

/**
 * Resolves `path` to the top level of the git checkout containing it, so
 * `trek-server add` works from any subdirectory. Throws with a user-facing
 * message when the path is missing or not in a repo.
 */
export function resolveRepoRoot(path: string): string {
  const abs = resolve(path)
  if (!existsSync(abs)) throw new Error(`${abs} does not exist`)
  let top: string
  try {
    top = execFileSync('git', ['-C', abs, 'rev-parse', '--show-toplevel'], hidden({
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10_000
    })).trim()
  } catch {
    throw new Error(`${abs} is not inside a git repository`)
  }
  return realpathSync(top)
}

/** The realpath of `path`, or just its resolved form when it does not exist (hand-written paths may be symlinked). */
export function realOrResolved(path: string): string {
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
  config: TrekServerConfig,
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

/**
 * Removes the repo whose id is `target`, or failing that, whose path is
 * `target` (or the git checkout containing it). Returns the removed repo, or
 * undefined when nothing matched.
 */
export function removeRepo(config: TrekServerConfig, target: string): RemoteRepo | undefined {
  let index = config.repos.findIndex((r) => r.id === target)
  if (index === -1) {
    const candidates = new Set([realOrResolved(target)])
    try {
      candidates.add(resolveRepoRoot(target))
    } catch {
      // Not a git checkout (or already deleted) — match the literal path only.
    }
    index = config.repos.findIndex((r) => candidates.has(realOrResolved(r.path)))
  }
  if (index === -1) return undefined
  const [removed] = config.repos.splice(index, 1)
  return removed
}

export function formatRepoList(repos: RemoteRepo[]): string {
  if (repos.length === 0) return 'No repos configured.'
  const rows = [['ID', 'NAME', 'PATH'], ...repos.map((r) => [r.id, r.name, r.path])]
  const widths = [0, 1].map((col) => Math.max(...rows.map((row) => row[col].length)))
  return rows
    .map((row) => `${row[0].padEnd(widths[0])}  ${row[1].padEnd(widths[1])}  ${row[2]}`)
    .join('\n')
}
