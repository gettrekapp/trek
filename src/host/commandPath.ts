// The program a child process of Trek's runs, found without the current directory. On Windows,
// libuv's spawn (execFile, spawn) and cmd.exe look a bare name (`git`) up in the current
// directory before PATH, and Trek runs git, docker and the rest with a worktree as their cwd
// (or the server's own): a repository that commits a `git.exe` at its root would get it run.
// So on Windows every bare name is resolved here to an absolute path, over PATH × PATHEXT only,
// and Windows' own tools (taskkill, where) come from %SystemRoot%\System32. Elsewhere the name
// is left as it is (execvp never searches the cwd unless PATH names it).
// scripts/childOptions.test.mjs checks that each spawn/execFile in server/src and src/host names
// its program through commandPath().
import { statSync } from 'node:fs'
import { win32 } from 'node:path'

export type Env = Record<string, string | undefined>

/** A variable of the env, by Windows' case-insensitive name (`Path`, `PATH`). */
export function envValue(env: Env, name: string): string | undefined {
  const wanted = name.toLowerCase()
  for (const [key, value] of Object.entries(env)) if (key.toLowerCase() === wanted && value !== undefined) return value
  return undefined
}

export const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD'

/** PATHEXT's extensions, lower case, in order. */
export function pathExts(env: Env): string[] {
  return (envValue(env, 'PATHEXT') ?? DEFAULT_PATHEXT)
    .split(';')
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.startsWith('.'))
}

/**
 * `name` (no directory part) in the first PATH directory that has it, trying `exts` in order
 * unless it already ends in one of them. Only absolute PATH entries count: a relative one (or an
 * empty one, which cmd.exe reads as `.`) would be the current directory again.
 */
export function findOnPath(name: string, env: Env, isFile: (path: string) => boolean, exts: readonly string[] = pathExts(env)): string | undefined {
  const hasExt = exts.includes(win32.extname(name).toLowerCase())
  for (const raw of (envValue(env, 'PATH') ?? '').split(';')) {
    const dir = raw.trim().replace(/^"(.*)"$/, '$1')
    if (!dir || !win32.isAbsolute(dir) || /^[\\/](?![\\/])/.test(dir)) continue
    const base = win32.join(dir, name)
    const hit = (hasExt ? [base] : exts.map((e) => base + e)).find((c) => isFile(c))
    if (hit) return hit
  }
  return undefined
}

/** cmd.exe's switch (also CreateProcess's, via NeedCurrentDirectoryForExePath) to skip the current directory in a program lookup. */
export const NO_CWD_EXE_LOOKUP = 'NoDefaultCurrentDirectoryInExePath'

/**
 * On Windows, sets NoDefaultCurrentDirectoryInExePath in `env` (the server's own process.env at
 * start), so a cmd.exe Trek starts (a batch file's session, the shims' own `node` lookup) and
 * everything they start never run a program from the current directory. Defence in depth:
 * libuv's spawn does not read it, which is what commandPath() is for.
 */
export function hardenWindowsEnv(env: Env, platform: NodeJS.Platform = process.platform): void {
  if (platform === 'win32') env[NO_CWD_EXE_LOOKUP] = '1'
}

/** Windows' own programs: run from System32 whatever PATH says. */
const SYSTEM_TOOLS = new Set(['taskkill', 'where', 'cmd', 'tasklist', 'reg'])

/** What execFile and spawn can start without a shell (Node refuses a .cmd or .bat without one). */
const RUNNABLE_EXTS = ['.com', '.exe']

export interface CommandPathDeps {
  platform?: NodeJS.Platform
  env?: Env
  isFile?: (path: string) => boolean
}

const realIsFile = (path: string): boolean => {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

// Hits by PATH, PATHEXT and name: git is spawned on every poll. A miss is looked up again (it may
// be installed meanwhile); a hit that has gone fails as ENOENT at spawn, like any missing program.
const cache = new Map<string, string>()

/**
 * The program to hand execFile/spawn for `name`. Not Windows, or a name with a directory part
 * (an absolute path, the caller's own choice): `name`. Windows: an absolute .exe/.com from PATH
 * (never the current directory), or System32's for Windows' own tools. Throws an ENOENT error
 * when PATH has no such program, as a spawn of a missing program would fail.
 */
export function commandPath(name: string, deps: CommandPathDeps = {}): string {
  if ((deps.platform ?? process.platform) !== 'win32') return name
  if (/[\\/]/.test(name) || win32.isAbsolute(name)) return name
  const env = deps.env ?? process.env
  const stem = name.toLowerCase().replace(/\.exe$/, '')
  if (SYSTEM_TOOLS.has(stem)) {
    const root = envValue(env, 'SystemRoot') || envValue(env, 'windir') || 'C:\\Windows'
    return win32.join(root, 'System32', `${stem}.exe`)
  }
  const key = deps.isFile ? null : `${envValue(env, 'PATH') ?? ''}\0${envValue(env, 'PATHEXT') ?? ''}\0${name.toLowerCase()}`
  const cached = key === null ? undefined : cache.get(key)
  if (cached) return cached
  const exts = pathExts(env).filter((e) => RUNNABLE_EXTS.includes(e))
  const hit = findOnPath(name, env, deps.isFile ?? realIsFile, exts.length > 0 ? exts : RUNNABLE_EXTS)
  if (!hit || !RUNNABLE_EXTS.includes(win32.extname(hit).toLowerCase())) {
    throw Object.assign(new Error(`spawn ${name} ENOENT: not found on PATH (the current directory is never searched)`), { code: 'ENOENT' })
  }
  if (key !== null) cache.set(key, hit)
  return hit
}
