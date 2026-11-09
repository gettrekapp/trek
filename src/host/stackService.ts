// The per-worktree dev stacks (a repository's docker/stack/stack.sh) on the machine this runs on
// (trek-server's, phase 5a): their status, start, stop, destroy and log. Electron-free: the state
// directory (logs and the `up` process's pid) is the caller's (the server's data dir), and the
// server resolves every worktree path from its own state before it calls these.
import { execFile, spawn } from 'node:child_process'
import { access, mkdir, open, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'
import type { StackLogChunk, StackStatus } from '../shared/types'

const execFileAsync = promisify(execFile)

export const STACK_SCRIPT = 'docker/stack/stack.sh'
const MAX_INITIAL_LOG = 64 * 1024
/** The most one `log` call reads: a reader that fell further behind skips ahead (its pane keeps the last 200 KB anyway). */
const MAX_LOG_READ = 1024 * 1024

const exists = (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false
  )

// Same location stack.sh uses for its registry of name → checkout/ports.
function registryDir(): string {
  return process.env.TREK_STACK_REGISTRY ?? join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'), 'trek', 'stacks')
}

const slugify = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '-')
    .replace(/^-+|-+$/g, '')

const physicalPath = (path: string): Promise<string> => realpath(path).catch(() => path)

function entryValue(text: string, key: string): string | undefined {
  return text.match(new RegExp(`^${key}=(.*)$`, 'm'))?.[1]
}

/** Mirrors stack.sh's naming: the name the checkout already has in the registry, else the checkout's directory name. */
async function resolveStack(ws: string): Promise<{ slug: string; port?: number; registered: boolean }> {
  const dir = registryDir()
  const files = await readdir(dir).catch(() => [] as string[])
  for (const file of files) {
    if (!file.startsWith('trek-')) continue
    const text = await readFile(join(dir, file), 'utf8').catch(() => '')
    const path = entryValue(text, 'path')
    if (path && (await physicalPath(path)) === ws) {
      const port = Number(entryValue(text, 'port'))
      return { slug: file.slice('trek-'.length), port: port || undefined, registered: true }
    }
  }
  return { slug: slugify(basename(ws)), registered: false }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function runningContainers(slug: string): Promise<number> {
  try {
    const { stdout } = await execFileAsync('docker', ['ps', '-q', '--filter', `label=com.docker.compose.project=trek-${slug}`], { timeout: 10_000 })
    return stdout.split('\n').filter(Boolean).length
  } catch {
    return 0
  }
}

// Conductor's variables would rename the stack or move its ports.
function stackEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  for (const key of Object.keys(env)) if (key.startsWith('CONDUCTOR_')) delete env[key]
  return env
}

async function waitForExit(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (alive(pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 250))
}

async function workspace(worktreePath: string): Promise<string> {
  const ws = await physicalPath(worktreePath)
  if (!(await exists(join(ws, STACK_SCRIPT)))) throw new Error(`No ${STACK_SCRIPT} in ${ws}`)
  return ws
}

export interface StackService {
  status(worktreePath: string): Promise<StackStatus>
  up(worktreePath: string, starter: boolean): Promise<void>
  down(worktreePath: string): Promise<number>
  destroy(worktreePath: string): Promise<number>
  log(worktreePath: string, fileId: number, offset: number): Promise<StackLogChunk>
}

export interface StackServiceOptions {
  /** Where each stack's log and `up` pid go (the server's `<dataDir>/stacks`) */
  stateDir: string
}

export function createStackService({ stateDir }: StackServiceOptions): StackService {
  const logFile = (slug: string): string => join(stateDir, `${slug}.log`)
  const pidFile = (slug: string): string => join(stateDir, `${slug}.pid`)
  const stopping = new Set<string>()

  const upPid = async (slug: string): Promise<number | undefined> => {
    const pid = Number(await readFile(pidFile(slug), 'utf8').catch(() => ''))
    return pid && alive(pid) ? pid : undefined
  }

  /** Runs stack.sh with its output appended to the stack's log file. */
  const runScript = async (
    ws: string,
    slug: string,
    args: string[],
    opts: { fresh?: boolean; detached?: boolean } = {}
  ): Promise<{ pid?: number; exit: Promise<number> }> => {
    await mkdir(stateDir, { recursive: true })
    // A fresh file (new inode) tells log readers a new run started.
    if (opts.fresh) await rm(logFile(slug), { force: true })
    const log = await open(logFile(slug), 'a')
    await log.write(`$ stack.sh ${args.join(' ')}\n`)
    // The process writes straight to the file, so `up` keeps running (and logging) across server
    // restarts without a pipe back to this process.
    const child = spawn('bash', [join(ws, STACK_SCRIPT), ...args], {
      cwd: ws,
      env: stackEnv(),
      detached: opts.detached,
      stdio: ['ignore', log.fd, log.fd]
    })
    const exit = new Promise<number>((resolve) => {
      child.on('error', () => resolve(-1))
      child.on('close', (code) => resolve(code ?? -1))
    })
    await log.close()
    if (opts.detached) child.unref()
    return { pid: child.pid, exit }
  }

  /**
   * Runs `stack.sh <command>` after Ctrl-C'ing the whole `up` process group, so a start still
   * restoring the database can't bring containers up afterwards.
   */
  const stopThenRun = async (worktreePath: string, command: 'down' | 'destroy'): Promise<number> => {
    const ws = await workspace(worktreePath)
    const { slug } = await resolveStack(ws)
    if (stopping.has(slug)) throw new Error(`Stack '${slug}' is already stopping`)
    stopping.add(slug)
    try {
      const pid = await upPid(slug)
      if (pid) {
        try {
          process.kill(-pid, 'SIGINT')
        } catch {
          // already gone
        }
        await waitForExit(pid, 60_000)
      }
      const { exit } = await runScript(ws, slug, [command])
      const code = await exit
      if (command === 'destroy' && code === 0) await rm(logFile(slug), { force: true })
      return code
    } finally {
      stopping.delete(slug)
    }
  }

  return {
    async status(worktreePath) {
      const ws = await physicalPath(worktreePath)
      if (!(await exists(join(ws, STACK_SCRIPT)))) {
        return { available: false, containers: 0, upRunning: false, stopping: false, hasAdmin: false, created: false }
      }
      const { slug, port, registered } = await resolveStack(ws)
      const [containers, pid, hasAdmin, hasStackDir] = await Promise.all([
        runningContainers(slug),
        upPid(slug),
        exists(join(ws, '.trek', 'stack', 'admin', 'pnpm-lock.yaml')),
        exists(join(ws, '.trek', 'stack'))
      ])
      return {
        available: true,
        slug,
        port,
        // The same test stack.sh destroy uses to decide there's nothing to remove
        created: registered || hasStackDir,
        containers,
        upRunning: pid != null,
        stopping: stopping.has(slug),
        hasAdmin
      }
    },

    async up(worktreePath, starter) {
      const ws = await workspace(worktreePath)
      const { slug } = await resolveStack(ws)
      if (stopping.has(slug)) throw new Error(`Stack '${slug}' is stopping`)
      if (await upPid(slug)) throw new Error(`Stack '${slug}' is already running`)
      const { pid, exit } = await runScript(ws, slug, starter ? ['up', '--starter'] : ['up'], { fresh: true, detached: true })
      if (pid == null) throw new Error('Could not start stack.sh')
      await writeFile(pidFile(slug), String(pid))
      void exit.then(() => rm(pidFile(slug), { force: true }))
    },

    down: (worktreePath) => stopThenRun(worktreePath, 'down'),

    destroy: (worktreePath) => stopThenRun(worktreePath, 'destroy'),

    async log(worktreePath, fileId, offset) {
      const { slug } = await resolveStack(await physicalPath(worktreePath))
      const path = logFile(slug)
      const info = await stat(path).catch(() => null)
      if (!info) return { fileId: 0, text: '', offset: 0 }
      const from = Math.max(info.ino === fileId ? offset : 0, info.size - (info.ino === fileId ? MAX_LOG_READ : MAX_INITIAL_LOG))
      if (from >= info.size) return { fileId: info.ino, text: '', offset: info.size }
      const handle = await open(path, 'r')
      try {
        const buffer = Buffer.alloc(info.size - from)
        await handle.read(buffer, 0, buffer.length, from)
        return { fileId: info.ino, text: buffer.toString('utf8'), offset: info.size }
      } finally {
        await handle.close()
      }
    }
  }
}
