// Becoming the new version: process.execve replaces this process with the install's launcher,
// which runs the swapped-in trek-server.cjs. The process id does not change, so a terminal, tmux
// or systemd sees one continuous process; the environment is handed on, and so are stdin, stdout
// and stderr (Node opens everything else close-on-exec). Node 22.15 and later, never Windows;
// without it an update still installs and the server says a restart finishes it.
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
 * Replaces this process with the install's launcher and `argv` (the arguments this server was
 * started with). Throws, with this process as it was, if this Node cannot or the launcher is not
 * there to run.
 */
export function relaunch(installDir: string, argv: readonly string[], host: RelaunchHost = HOST): never {
  if (!canRelaunch(host) || !host.execve) throw new Error('this Node cannot replace a running process (process.execve needs Node 22.15 or later, and is not on Windows)')
  const launcher = launcherPath(installDir)
  // execve does not throw when the file cannot be run: Node aborts the process (a core dump, no
  // exit code a caller chose). So what can be known beforehand is checked here.
  if (!runnable(launcher)) throw new Error(`${launcher} is missing or cannot be run`)
  // args[0] is the program's own name, as for execve(2): the arguments start at args[1].
  return host.execve(launcher, [launcher, ...argv], process.env)
}
