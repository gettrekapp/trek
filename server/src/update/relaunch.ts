// Becoming the new version: process.execve replaces this process with the install's launcher,
// which runs the swapped-in trek-server.cjs. The process id does not change, so a terminal, tmux
// or systemd sees one continuous process; the environment is handed on, with the Node this server
// runs under named for the launcher (TREK_NODE), and so are stdin, stdout and stderr (Node opens
// everything else close-on-exec). Node 22.15 and later, never Windows; without it an update still
// installs and the server says a restart finishes it.
import { accessSync, constants, statSync } from 'node:fs'
import { join } from 'node:path'

type Execve = (file: string, args?: readonly string[], env?: NodeJS.ProcessEnv) => never

/** The parts of `process` a relaunch needs: tests pass their own. */
export interface RelaunchHost {
  platform: NodeJS.Platform
  execve?: Execve
}

const HOST = process as unknown as RelaunchHost

export function canRelaunch(host: RelaunchHost = HOST): boolean {
  return host.platform !== 'win32' && typeof host.execve === 'function'
}

export function launcherPath(installDir: string): string {
  return join(installDir, 'bin', 'trek-server')
}

function runnable(file: string): boolean {
  try {
    accessSync(file, constants.X_OK)
    return statSync(file).isFile()
  } catch {
    return false
  }
}

/**
 * The environment the new version is started with: this one, with TREK_NODE naming the Node this
 * server runs under (the one it was started with, if it named one), so the launcher runs the new
 * version with the same binary: not whichever `node` is on PATH, and not none (a server started
 * as `/opt/node/bin/node trek-server.cjs`). `trek-server update` gives the new version's
 * selfcheck the same, so what is checked is what will run.
 */
export function relaunchEnv(env: NodeJS.ProcessEnv = process.env, execPath: string = process.execPath): NodeJS.ProcessEnv {
  return { ...env, TREK_NODE: env.TREK_NODE || execPath }
}

/**
 * Why this process cannot become `installDir`'s launcher, or null when it can. Asked before a
 * relaunch is accepted (the server is still up, and stays up) and again before the execve.
 */
export function relaunchRefusal(installDir: string, host: RelaunchHost = HOST): string | null {
  if (!canRelaunch(host)) return 'this Node cannot replace a running process (process.execve needs Node 22.15 or later, and is not on Windows)'
  const launcher = launcherPath(installDir)
  // execve does not throw when the file cannot be run: Node aborts the process (a core dump, no
  // exit code a caller chose). So what can be known beforehand is checked here.
  if (!runnable(launcher)) return `${launcher} is missing or cannot be run`
  return null
}

/**
 * Replaces this process with the install's launcher and `argv` (the arguments this server was
 * started with). Throws, with this process as it was, if this Node cannot or the launcher is not
 * there to run.
 */
export function relaunch(installDir: string, argv: readonly string[], host: RelaunchHost = HOST): never {
  const refusal = relaunchRefusal(installDir, host)
  if (refusal !== null || !host.execve) throw new Error(refusal ?? 'this Node cannot replace a running process')
  const launcher = launcherPath(installDir)
  // args[0] is the program's own name, as for execve(2): the arguments start at args[1].
  return host.execve(launcher, [launcher, ...argv], relaunchEnv())
}
