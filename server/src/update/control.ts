// How `trek-server update` reaches a running server: a Unix socket beside its config file, 0600,
// so only the server's own user can connect (the config holds only token hashes, so the command
// cannot sign in over the protocol). One request per connection, a line of JSON each way:
// {"op":"status"} and {"op":"relaunch"}. Nobody listening means no server is running with that config.
import { chmodSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createConnection, createServer, type Server, type Socket } from 'node:net'
import { dirname, join } from 'node:path'

export const CONTROL_SOCKET = 'control.sock'

export function controlPath(configPath: string): string {
  return join(dirname(configPath), CONTROL_SOCKET)
}

export interface ControlStatus {
  pid: number
  version: string
  /** The folder the running server's files are in */
  installDir: string
  /** Terminals running now: they close on a relaunch */
  sessions: number
  canRelaunch: boolean
}

export type RelaunchAnswer = { ok: true } | { ok: false; error: string }

export interface ControlHandlers {
  status: () => ControlStatus
  /** Starts the relaunch (after answering) or says why not */
  relaunch: () => RelaunchAnswer
}

/** A request is one short line. */
const MAX_REQUEST_CHARS = 4096
/** How long a client may stay connected without having sent its request, or without closing after the answer. */
const IDLE_MS = 5000
const PROBE_MS = 1000
/** Tries at the socket's path while other servers starting at the same moment are settling who has it. */
const LISTEN_ATTEMPTS = 8
const SETTLE_MS = 50
/** Removing a stale socket takes moments (at most one probe, PROBE_MS): a lock older than this was left behind. */
const LOCK_STALE_MS = 10_000

/**
 * Whether `path` fits a Unix socket's address (sun_path: 104 bytes on macOS and the BSDs, 108 on
 * Linux, one of them the closing NUL). Node does not refuse a longer path: it cuts it short and
 * listens on, or connects to, a file of another name. So a path is checked before any use.
 */
export function socketPathFits(path: string, platform: NodeJS.Platform = process.platform): boolean {
  return Buffer.byteLength(path) <= (platform === 'linux' ? 107 : 103)
}

/** One request to the socket at `path`. null when nothing answers (no server, or no socket) within `timeoutMs`. */
export function controlRequest(path: string, op: string, timeoutMs = 3000): Promise<unknown | null> {
  if (!socketPathFits(path)) return Promise.resolve(null)
  return new Promise((resolve) => {
    let data = ''
    let settled = false
    let socket: Socket | undefined
    const done = (value: unknown | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket?.destroy()
      resolve(value)
    }
    // The whole exchange's time, not an idle time: a server that trickles bytes is no answer either.
    const timer = setTimeout(() => done(null), timeoutMs)
    try {
      socket = createConnection(path)
    } catch {
      done(null)
      return
    }
    socket.setEncoding('utf8')
    socket.on('connect', () => socket?.write(JSON.stringify({ op }) + '\n'))
    socket.on('data', (chunk: string) => {
      data += chunk
      const end = data.indexOf('\n')
      if (end < 0) {
        if (data.length > 1024 * 1024) done(null)
        return
      }
      try {
        done(JSON.parse(data.slice(0, end)))
      } catch {
        done(null)
      }
    })
    socket.on('error', () => done(null))
    socket.on('close', () => done(null))
  })
}

/**
 * Whether a process is listening on the socket file at `path`: the kernel completes a connection
 * to a listening socket whether or not its server gets round to answering, so a busy server is
 * never taken for a dead one. Only "nothing is listening" (refused, not a socket, no file) is
 * false; anything unclear (no answer in time, not this user's) counts as in use.
 */
function listening(path: string): Promise<boolean> {
  if (!socketPathFits(path)) return Promise.resolve(true)
  return new Promise((resolve) => {
    let settled = false
    let socket: Socket | undefined
    const done = (value: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket?.destroy()
      resolve(value)
    }
    const timer = setTimeout(() => done(true), PROBE_MS)
    try {
      socket = createConnection(path)
    } catch {
      done(true)
      return
    }
    socket.on('connect', () => done(true))
    socket.on('error', (err: NodeJS.ErrnoException) => done(!(err.code === 'ECONNREFUSED' || err.code === 'ENOTSOCK' || err.code === 'ENOENT')))
  })
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM: it exists, and is someone else's.
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * The lock `${path}.lock`, held only while a stale socket file is removed (moments). False when
 * another process holds it. One left by a process that died holding it, or older than any
 * removal takes, is taken over.
 */
function takeLock(lock: string): boolean {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(lock, String(process.pid), { flag: 'wx', mode: 0o600 })
      return true
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      try {
        const holder = Number(readFileSync(lock, 'utf8').trim())
        const age = Date.now() - statSync(lock).mtimeMs
        // An empty file is one being written this moment: only its age can call it stale.
        if (age < LOCK_STALE_MS && !(Number.isInteger(holder) && holder > 0 && !alive(holder))) return false
      } catch {
        // Gone again: try once more.
      }
      rmSync(lock, { force: true })
    }
  }
  return false
}

/**
 * The file at `path` is in the way of a listen: 'live' when a server listens on it (the socket is
 * that server's), 'cleared' when nobody did and it is removed, 'busy' when another server is
 * removing it at this moment.
 *
 * Looking and then removing is only safe one process at a time: of two servers that start
 * together and both see a stale file, the first removes it and listens, and the second would
 * then remove the first one's live socket, leaving it listening on a file nobody can reach. So
 * the look and the removal happen under a lock. A file can only become a live socket by being
 * removed first (listen never replaces a file), and only the lock's holder removes, so what the
 * holder saw dead is still dead when it removes it.
 */
async function clearStale(path: string): Promise<'live' | 'cleared' | 'busy'> {
  if (await listening(path)) return 'live'
  const lock = `${path}.lock`
  if (!takeLock(lock)) return 'busy'
  try {
    if (await listening(path)) return 'live'
    rmSync(path, { force: true })
    return 'cleared'
  } finally {
    rmSync(lock, { force: true })
  }
}

/** Listens on `path`, the socket file created 0600. Rejects with listen's error (EADDRINUSE: a file is there). */
function bind(server: Server, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const settle = (err?: Error): void => {
      server.off('error', settle)
      server.off('listening', onListening)
      if (err) reject(err)
      else resolve()
    }
    const onListening = (): void => settle()
    server.once('error', settle)
    server.once('listening', onListening)
    // bind(2) happens inside listen(), before it returns, and creates the file with the umask's
    // mode: so the umask is what makes it 0600 from its first moment (a chmod afterwards would
    // leave it open to others until then; the config folder is not always 0700).
    const umask = process.umask(0o177)
    try {
      server.listen(path)
    } catch (err) {
      settle(err as Error)
    } finally {
      process.umask(umask)
    }
  })
}

function answer(line: string, handlers: ControlHandlers): unknown {
  let op: unknown
  try {
    op = (JSON.parse(line) as { op?: unknown }).op
  } catch {
    op = undefined
  }
  try {
    if (op === 'status') return handlers.status()
    if (op === 'relaunch') return handlers.relaunch()
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
  return { ok: false, error: 'unknown request' }
}

/**
 * Listens on `path`. null (with one warning) when it cannot: another live server has the socket,
 * the path is too long for one, or its folder cannot hold one. A leftover file nobody listens on
 * is replaced.
 */
export async function listenControl(path: string, handlers: ControlHandlers, opts: { idleMs?: number } = {}): Promise<{ close(): void } | null> {
  const none = (why: string): null => {
    console.warn(`update: no control socket at ${path} (${why}); \`trek-server update\` cannot restart this server by itself`)
    return null
  }
  if (!socketPathFits(path)) return none('the path is too long for a Unix socket')
  const server = createServer((socket) => {
    let data = ''
    let answered = false
    socket.setEncoding('utf8')
    // A client that connects and says nothing, or never closes, does not stay.
    socket.setTimeout(opts.idleMs ?? IDLE_MS, () => socket.destroy())
    socket.on('error', () => {})
    socket.on('data', (chunk: string) => {
      if (answered) return
      data += chunk
      const end = data.indexOf('\n')
      if (end < 0 ? data.length > MAX_REQUEST_CHARS : end > MAX_REQUEST_CHARS) {
        socket.destroy()
        return
      }
      if (end < 0) return
      answered = true
      socket.end(JSON.stringify(answer(data.slice(0, end), handlers)) + '\n')
    })
  })
  try {
    for (let attempt = 1; ; attempt++) {
      try {
        await bind(server, path)
        break
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE' || attempt >= LISTEN_ATTEMPTS) throw err
        const state = await clearStale(path)
        if (state === 'live') return none('another trek-server is running with this config and has it')
        // Another server starting at this moment is clearing the same file: see who has the path after it.
        if (state === 'busy') await new Promise((resolve) => setTimeout(resolve, SETTLE_MS))
      }
    }
    chmodSync(path, 0o600)
  } catch (err) {
    if (server.listening) server.close()
    return none((err as Error).message)
  }
  server.on('error', () => {})
  // The socket must not keep a server alive that is otherwise done.
  server.unref()
  let closed = false
  return {
    close: () => {
      if (closed) return
      closed = true
      // Closing also removes the file (Node unlinks a socket path it bound).
      server.close()
      rmSync(path, { force: true })
    }
  }
}
