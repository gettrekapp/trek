// The Local server's one-time take-over of the environments registry the app kept before 5a
// (plugins E2: the registry half of server/src/integrations/envSeed.ts, whose stacks half stays in
// core as stackSeed.ts). The VM names do not change (deriveProfileName over the repository's
// envRepoKey, which the import keeps as `profileKey`), so the VMs, containers and volumes stay where
// they are: only the registry moves.
//
// Only while the plugin has no registry yet (data.ts); with no registry to copy it writes an empty
// one, so a later start never copies again. A registry it cannot read or parse (an older Trek may be
// writing it, not atomically) throws and writes nothing, so the next start tries again, rather than
// taking every VM for an orphan for good. The app's file is left as it was.
//
// The plugin's registry is never overwritten: it is written to a temp file (0600: a branch's
// variables may hold secrets) and hard-linked into place, which fails if a registry appeared
// meanwhile. Only well-formed entries are copied, with their variables and compose file held to the
// checks `env.up` applies (args.ts), since the registry's variables reach docker compose.
import { linkSync, lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute } from 'node:path'
import { optionalComposeFile, optionalEnvVars, requireProfile } from './args.ts'

export interface RegistrySeedResult {
  /** Whether this start took the app's registry over (false: the plugin already had one) */
  seeded: boolean
  /** Entries copied */
  environments: number
  /** Entries or parts of them left out, as text for the log */
  skipped: string[]
}

interface SeedEntry {
  repoPath: string
  branch: string
  worktreePath: string
  composeFile?: string
  envVars?: Record<string, string>
  createdAt: string
}

export const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** Whether anything (a file, a directory, a symlink, even a dangling one) is at the path. */
export function present(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw err
  }
}

const isProfile = (profile: string): boolean => {
  try {
    requireProfile(profile)
    return true
  } catch {
    return false
  }
}

/** One registry entry, as the service's RegistryEntry, or undefined when it is not one. */
function seedEntry(profile: string, entry: unknown, skipped: string[]): SeedEntry | undefined {
  if (
    !isProfile(profile) ||
    !isRecord(entry) ||
    typeof entry.repoPath !== 'string' ||
    !isAbsolute(entry.repoPath) ||
    typeof entry.branch !== 'string' ||
    typeof entry.worktreePath !== 'string' ||
    !isAbsolute(entry.worktreePath) ||
    typeof entry.createdAt !== 'string'
  ) {
    return undefined
  }
  const out: SeedEntry = { repoPath: entry.repoPath, branch: entry.branch, worktreePath: entry.worktreePath, createdAt: entry.createdAt }
  if (entry.composeFile !== undefined && entry.composeFile !== null) {
    try {
      const composeFile = optionalComposeFile(entry.composeFile, entry.worktreePath)
      if (composeFile !== undefined) out.composeFile = composeFile
    } catch (err) {
      skipped.push(`environment ${JSON.stringify(profile)}'s compose file (${(err as Error).message}; the default file is used)`)
    }
  }
  if (isRecord(entry.envVars)) {
    const vars: Record<string, string> = {}
    for (const [key, value] of Object.entries(entry.envVars)) {
      try {
        Object.assign(vars, optionalEnvVars({ [key]: value }))
      } catch {
        skipped.push(`environment ${JSON.stringify(profile)}'s variable ${JSON.stringify(key)}`)
      }
    }
    if (Object.keys(vars).length > 0) out.envVars = vars
  } else if (entry.envVars !== undefined && entry.envVars !== null) {
    skipped.push(`environment ${JSON.stringify(profile)}'s variables (not an object)`)
  }
  return out
}

/** The app's registry, entry by entry: only well-formed twb- entries with absolute paths. None is an empty registry; one that cannot be read or parsed throws. */
function readAppRegistry(file: string, skipped: string[]): Record<string, SeedEntry> {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw new Error(`${file} cannot be read (${(err as Error).message})`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    throw new Error(`${file} does not parse (${(err as Error).message})`)
  }
  if (!isRecord(parsed)) throw new Error(`${file} is not a JSON object`)
  const out: Record<string, SeedEntry> = {}
  for (const [profile, entry] of Object.entries(parsed)) {
    const seeded = seedEntry(profile, entry, skipped)
    if (seeded) out[profile] = seeded
    else skipped.push(`environment ${JSON.stringify(profile)}`)
  }
  return out
}

/**
 * Writes `text` to `file` at 0600, atomically, only if nothing is there: false when something (even
 * a dangling symlink) appeared meanwhile. Used for the take-over and for data.ts's copy from the old place.
 */
export function writeFileOnce(file: string, text: string): boolean {
  const tmp = `${file}.${process.pid}.seed.tmp`
  // A temp file a crash left behind would keep its mode; `wx` below then creates it afresh at 0600.
  try {
    unlinkSync(tmp)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
  try {
    writeFileSync(tmp, text, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    try {
      // link(2), unlike rename(2), never replaces what is there.
      linkSync(tmp, file)
      return true
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false
      throw err
    }
  } finally {
    try {
      unlinkSync(tmp)
    } catch {
      // best effort
    }
  }
}

/** The app's registry (`appRegistryFile`) as the plugin's (`registryFile`), once: only while there is nothing at `registryFile`. */
export function seedRegistryFromApp(appRegistryFile: string, registryFile: string): RegistrySeedResult {
  const skipped: string[] = []
  if (present(registryFile)) return { seeded: false, environments: 0, skipped }
  // Read first: a registry that cannot be read throws before anything is written.
  const registry = readAppRegistry(appRegistryFile, skipped)
  mkdirSync(dirname(registryFile), { recursive: true, mode: 0o700 })
  if (!writeFileOnce(registryFile, JSON.stringify(registry, null, 2))) return { seeded: false, environments: 0, skipped }
  return { seeded: true, environments: Object.keys(registry).length, skipped }
}
