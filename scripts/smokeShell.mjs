// scripts/smokeShell.mjs — the login shell an Electron smoke gives the app as SHELL, and the
// startup file that shell reads in the smoke's temp HOME.
//
// The shell must exist: main's fixPath reads PATH from `$SHELL -ilc` (src/main/env.ts), and the
// Local server runs each agent as `$SHELL -ilc <command>` (server/src/sessions/launch.ts), so a
// SHELL that is not there leaves main's PATH as it was and every agent's pty exiting at once.
// macOS: zsh, a Mac's login shell. Elsewhere: bash, Ubuntu's and Debian's (the ubuntu-22.04
// runners have no zsh). TREK_SMOKE_SHELL picks another (say /bin/bash, to try the Linux leg's
// setup on a Mac).
import { existsSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'

export const SMOKE_SHELL = process.env.TREK_SMOKE_SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash')
if (!existsSync(SMOKE_SHELL)) throw new Error(`smokeShell: the smokes' login shell ${SMOKE_SHELL} is not installed`)

/** The file `$SHELL -ilc` reads in `home`: zsh's .zshrc (an interactive shell), bash's .bash_profile (a login one). */
export function shellRc(home) {
  const name = basename(SMOKE_SHELL)
  if (name === 'zsh') return join(home, '.zshrc')
  if (name === 'bash') return join(home, '.bash_profile')
  throw new Error(`smokeShell: no startup file known for ${SMOKE_SHELL}`)
}

/** Writes `content` (a PATH export, or nothing) where the smoke's login shell reads it in `home`. */
export const writeShellRc = (home, content = '') => writeFileSync(shellRc(home), content)
