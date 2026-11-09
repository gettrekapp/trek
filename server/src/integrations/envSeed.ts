// The Local server's one-time take-over of the environments the app ran itself before 5a.
//
// Before 5a, the Trek app's main process ran Colima, docker and the dev stacks for Local windows,
// with its environments registry in its userData (`environments.json`: each twb- VM's repository,
// branch and worktree) and each stack's log and `stack.sh up` pid in `userData/stacks`. The VM
// names do not change (deriveProfileName over the repository's envRepoKey, which the import keeps
// as `profileKey`), nor do the stacks' (the checkout's path), so the VMs, containers and volumes
// stay where they are: only the registry and the stack files move.
//
// `trek-server start --local --import-env-from <userData>` copies them into the server's data dir
// before it serves anything, once: only while the data dir has no environments.json yet. With no
// registry to copy it writes an empty one, so a later start never copies again. A registry it
// cannot read or parse (an older Trek may be writing it, not atomically) throws and writes nothing,
// so the next start tries again, rather than taking every VM for an orphan for good.
//
// The app's registry and pid files are copied and left as they were (a dev build and the installed
// app share that userData, and each Local profile takes its own copy). A stack's log is shared, as
// a hard link: the app's `stack.sh up` and the server's `stack.down`/`destroy` both only append to
// it. Known limit: an older Trek still running on that userData after the take-over (or the other
// Local profile) starts stacks this server cannot see, since each takes its own snapshot.
//
// The server's registry is never overwritten: it is written to a temp file (0600: a branch's
// variables may hold secrets) and hard-linked into place, which fails if a registry appeared
// meanwhile. Only well-formed entries are copied, with their variables and compose file held to
// the checks `env.up` applies (args.ts), since the registry's variables reach docker compose.
import { constants, copyFileSync, linkSync, lstatSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { isRecord } from '../validate.ts'
import { optionalComposeFile, optionalEnvVars, requireProfile } from './args.ts'
import { ENV_REGISTRY_FILE, STACKS_DIR } from './machine.ts'

/** A stack file the app's stacks.ts wrote: `<slug>.log` or `<slug>.pid` */
const STACK_FILE_RE = /^[a-z0-9][a-z0-9-]*\.(log|pid)$/
/** A pid file's text, as the stack service writes it (`String(pid)`) */
const PID_RE = /^\s*([1-9][0-9]{0,9})\s*$/

export interface EnvSeedResult {
  /** Whether this start took the app's files over (false: the data dir already had its registry) */
  seeded: boolean
  /** Registry entries copied */
  environments: number
  /** Stack files copied or linked */
  stackFiles: number
  /** Entries left out, as text for the log */
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

/** Whether anything (a file, a directory, a symlink, even a dangling one) is at the path. */
function present(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw err
  }
}

/** Whether a process has the pid: ESRCH is none, EPERM another user's (alive). */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
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

/** One registry entry, as environmentService's RegistryEntry, or undefined when it is not one. */
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

/**
 * The app's registry, entry by entry: only well-formed twb- entries with absolute paths. None is an
 * empty registry; one that cannot be read or parse throws (nothing is written, the next start retries).
 */
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
 * The app's stack files into `toStacks`: each `<slug>.log` hard-linked (a `stack.sh up` still
 * running from the app keeps writing to the same inode), else copied; each `<slug>.pid` written
 * afresh as the stack service writes it, so its pid-compare cleanup reads the same text and a
 * write to it never reaches the app's file. Only regular files; nothing already there is replaced.
 */
function seedStackFiles(fromStacks: string, toStacks: string, result: EnvSeedResult): void {
  let names: string[] = []
  try {
    names = readdirSync(fromStacks)
  } catch {
    return
  }
  for (const name of names) {
    if (!STACK_FILE_RE.test(name)) continue
    const source = join(fromStacks, name)
    const target = join(toStacks, name)
    try {
      if (!lstatSync(source).isFile()) {
        result.skipped.push(`${name}: not a regular file`)
        continue
      }
      mkdirSync(toStacks, { recursive: true, mode: 0o700 })
      if (present(target)) continue
      if (name.endsWith('.pid')) {
        const pid = PID_RE.exec(readFileSync(source, 'utf8'))?.[1]
        if (pid === undefined) {
          result.skipped.push(`${name}: not a pid`)
          continue
        }
        // A stack that ended while the app was closed: its pid may be another process's by now,
        // which the stack service's down would Ctrl-C.
        if (!alive(Number(pid))) {
          result.skipped.push(`${name}: no process ${pid}`)
          continue
        }
        writeFileSync(target, pid, { flag: 'wx', mode: 0o600 })
      } else {
        try {
          linkSync(source, target)
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue
          // Another volume, or a file system without hard links: a copy (the app's run keeps logging to its own).
          copyFileSync(source, target, constants.COPYFILE_EXCL)
        }
      }
      result.stackFiles += 1
    } catch (err) {
      result.skipped.push(`${name}: ${(err as Error).message}`)
    }
  }
}

/** Writes the registry at 0600, atomically, only if there is none: false when one appeared meanwhile. */
function writeRegistryOnce(registryFile: string, registry: Record<string, SeedEntry>): boolean {
  const tmp = `${registryFile}.${process.pid}.seed.tmp`
  // A temp file a crash left behind would keep its mode; `wx` below then creates it afresh at 0600.
  try {
    unlinkSync(tmp)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
  try {
    writeFileSync(tmp, JSON.stringify(registry, null, 2), { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    try {
      // link(2), unlike rename(2), never replaces what is there.
      linkSync(tmp, registryFile)
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

export function seedEnvironmentsFromApp(appDir: string, dataDir: string): EnvSeedResult {
  const result: EnvSeedResult = { seeded: false, environments: 0, stackFiles: 0, skipped: [] }
  const registryFile = join(dataDir, ENV_REGISTRY_FILE)
  if (present(registryFile)) return result
  // Read first: a registry that cannot be read throws before anything is written.
  const registry = readAppRegistry(join(appDir, ENV_REGISTRY_FILE), result.skipped)
  mkdirSync(dataDir, { recursive: true, mode: 0o700 })

  // The stack files before the registry: once the registry is written, this never runs again.
  seedStackFiles(join(appDir, STACKS_DIR), join(dataDir, STACKS_DIR), result)

  if (!writeRegistryOnce(registryFile, registry)) return { seeded: false, environments: 0, stackFiles: result.stackFiles, skipped: result.skipped }
  result.seeded = true
  result.environments = Object.keys(registry).length
  return result
}
