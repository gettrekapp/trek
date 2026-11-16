// Becoming the new version: process.execve replaces this process with the install's launcher,
// which runs the swapped-in trek-server.cjs. The process id does not change, so a terminal, tmux
// or systemd sees one continuous process; the environment is handed on, with the Node this server
// runs under named for the launcher (TREK_NODE), and so are stdin, stdout and stderr (Node opens
// everything else close-on-exec; what node-pty left open is closed first, closeTerminalDescriptors). Node 22.15 and later, never Windows; without it an update still
// installs and the server says a restart finishes it.
import { accessSync, closeSync, constants, fstatSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

type Execve = (file: string, args?: readonly string[], env?: NodeJS.ProcessEnv) => never

/** The parts of `process` a relaunch needs: tests pass their own. */
export interface RelaunchHost {
  platform: NodeJS.Platform
  execve?: Execve
  /** Closes what this process's terminals left open, just before the execve */
  closeTerminals?: () => void
}

/** What closeTerminalDescriptors uses of node:fs (the tests' stand-in) */
export interface DescriptorFs {
  readdirSync(dir: string): string[]
  fstatSync(fd: number): { isCharacterDevice(): boolean }
  closeSync(fd: number): void
}

/**
 * Closes this process's descriptors above stderr that are character devices: the terminals'.
 * Only as the very last thing before execve, when nothing in this process will run again.
 *
 * Why: execve keeps every descriptor that is not close-on-exec. Node opens its own that way, but
 * node-pty does not open a pty's, and on macOS (node-pty 1.1.0, pty_posix_spawn) each terminal
 * ever started also leaves two descriptors nothing in JavaScript knows of: the slave side, and a
 * spare pty master. TerminalHost.forceKillAll() closes the ones node-pty knows; these it cannot.
 * Without this, a server that restarted into an update would carry them all, update after update
 * (an exit and a new start would not).
 *
 * Why only character devices, and not everything above 2: a pty (and /dev/null, which the new
 * process opens for itself) is all that this can close, so a descriptor someone deliberately
 * handed the server to keep (a service manager's socket, a log pipe) is left alone. Returns how
 * many it closed. Never throws.
 *
 * Why never one that fstat cannot describe: on macOS that is also what a kernel-guarded descriptor
 * looks like (NECP, the network policy one the system opens once the server has connected out,
 * to the release feed for one), and closing a guarded descriptor is EXC_GUARD: the kernel kills
 * the process at once (SIGKILL, nothing logged), so the server would be gone instead of
 * restarted. A killed shell's revoked terminal looks the same and is left too: it holds no pty,
 * only a dead handle the new version carries.
 */
export function closeTerminalDescriptors(platform: NodeJS.Platform = process.platform, fs: DescriptorFs = { readdirSync, fstatSync, closeSync }): number {
  let names: string[]
  try {
    names = fs.readdirSync(platform === 'linux' ? '/proc/self/fd' : '/dev/fd')
  } catch {
    return 0
  }
  let closed = 0
  for (const name of names) {
    const fd = Number(name)
    if (!Number.isInteger(fd) || fd <= 2) continue
    let terminal: boolean
    try {
      terminal = fs.fstatSync(fd).isCharacterDevice()
    } catch {
      // Not known to be a terminal, so never closed: a guarded descriptor (macOS NECP) fails
      // fstat with EBADF, and closing it kills this process. So does a killed shell's revoked
      // terminal, and the listing's own descriptor, closed again by now.
      terminal = false
    }
    if (!terminal) continue
    try {
      fs.closeSync(fd)
      closed++
    } catch {
      // Not open after all.
    }
  }
  return closed
}

const HOST: RelaunchHost = {
  platform: process.platform,
  execve: typeof process.execve === 'function' ? (file, args, env) => process.execve!(file, args, env) : undefined,
  closeTerminals: () => void closeTerminalDescriptors()
}

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
  // From here nothing of this process runs again: Node's execve does not return, and aborts the process if the kernel refuses.
  host.closeTerminals?.()
  // args[0] is the program's own name, as for execve(2): the arguments start at args[1].
  return host.execve(launcher, [launcher, ...argv], relaunchEnv())
}
