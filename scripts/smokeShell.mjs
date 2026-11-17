// scripts/smokeShell.mjs — the login shell an Electron smoke gives the app as SHELL, and the
// startup file that shell reads in the smoke's temp HOME.
//
// The shell must exist: main's fixPath reads PATH from `$SHELL -ilc` (src/main/env.ts), and the
// Local server runs each agent as `$SHELL -ilc <command>` (server/src/sessions/launch.ts), so a
// SHELL that is not there leaves main's PATH as it was and every agent's pty exiting at once.
// macOS: zsh, a Mac's login shell. Elsewhere: bash, Ubuntu's and Debian's (the ubuntu-22.04
// runners have no zsh). TREK_SMOKE_SHELL picks another (say /bin/bash, to try the Linux leg's
// setup on a Mac).
//
// Windows has no login shell: the server starts agents directly, not through `$SHELL -ilc`, and
// fixPath returns on win32. So SMOKE_SHELL is undefined there (unless TREK_SMOKE_SHELL is set),
// nothing checks that it exists, and writeShellRc writes nothing. A smoke leaves SHELL out of the
// app's env when it is undefined, and puts its stub tools on PATH through the env instead
// (stubsFirstOnPath), since no startup file is read.
import { existsSync, writeFileSync } from 'node:fs'
import { basename, delimiter, join } from 'node:path'
import { localProfilePath } from '../src/shared/localServer.ts'

const WIN = process.platform === 'win32'

export const SMOKE_SHELL = process.env.TREK_SMOKE_SHELL || (WIN ? undefined : process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash')
if (SMOKE_SHELL && !existsSync(SMOKE_SHELL)) throw new Error(`smokeShell: the smokes' login shell ${SMOKE_SHELL} is not installed`)

/** The file `$SHELL -ilc` reads in `home`: zsh's .zshrc (an interactive shell), bash's .bash_profile (a login one). */
export function shellRc(home) {
  const name = basename(SMOKE_SHELL)
  if (name === 'zsh') return join(home, '.zshrc')
  if (name === 'bash') return join(home, '.bash_profile')
  throw new Error(`smokeShell: no startup file known for ${SMOKE_SHELL}`)
}

/** Writes `content` (a PATH export, or nothing) where the smoke's login shell reads it in `home`. Nothing on Windows. */
export const writeShellRc = (home, content = '') => {
  if (WIN) return
  writeFileSync(shellRc(home), content)
}

/**
 * On Windows only: puts `dir` first on the PATH in `env` (a copy of process.env, whose PATH key is
 * "Path" there), since no startup file does it. Elsewhere the shell's rc file does, so this is a no-op.
 */
export function stubsFirstOnPath(env, dir) {
  if (!WIN) return env
  const key = Object.keys(env).find((k) => k.toLowerCase() === 'path') ?? 'Path'
  env[key] = env[key] ? `${dir}${delimiter}${env[key]}` : dir
  return env
}

/**
 * The variables that put a smoke's temp `home` where the app, trek-server and the agents look for
 * the user's folders: HOME, and on Windows, which does not derive them from HOME, USERPROFILE
 * (os.homedir(): ~/.claude), APPDATA (trek-server's config dir, which holds the Local server's
 * profile) and LOCALAPPDATA (its data dir). Without them a smoke on Windows writes its fixtures
 * under HOME while the server reads, and writes, the runner's own profile.
 */
export function homeEnv(home) {
  if (!WIN) return { HOME: home }
  return { HOME: home, USERPROFILE: home, APPDATA: join(home, 'AppData', 'Roaming'), LOCALAPPDATA: join(home, 'AppData', 'Local') }
}

/** The Local server profile `name` (`dev`: local-dev; none: local) of the smoke's temp `home` (homeEnv), where the app's Local server reads it. */
export const smokeLocalProfile = (home, name) => localProfilePath(join, process.platform, homeEnv(home), home, name)

/**
 * Whether the smoke's trek-server (always on this machine) has environments and dev stacks: not on
 * Windows yet (welcomeCapabilities drops env and stacks on win32, server/src/capabilities.ts). A
 * check of them prints `SKIP <check> (NO_ENVS)` there instead.
 */
export const SERVER_HAS_ENVS = !WIN
export const NO_ENVS = 'trek-server on Windows has no environments or dev stacks yet'
