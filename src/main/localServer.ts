// The Local server supervisor (spec, "Local server supervisor (phase 4)"). On launch it
// reads local.json and probes it; if nothing usable answers it spawns the bundled
// out/server/trek-server.cjs with Electron's Node (`start --local`), detached, with a
// cleaned env and its output in the profile's server.log, and waits for local.json.
// It holds the running server's LocalInfo for main only: the token goes to the relay
// and main's own connection (appServers.getAppServerToken('local')), never to a
// renderer, and never to disk here. The server keeps running when Trek quits, unless
// the "Stop local server on quit" app setting is on. A dev build (not packaged) uses
// its own profile, local-dev (`--local-profile dev`), so it never restarts the
// installed Trek's server. The decisions are pure, in localServerRules.ts; this file
// does the I/O.
import { app, dialog, ipcMain } from 'electron'
import { spawn } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, unlinkSync, watch, writeSync, type FSWatcher } from 'node:fs'
import { createConnection } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseLocalInfo, type LocalInfo } from '../shared/localServer.ts'
import { globalSocketFactory } from '../shared/client/index.ts'
import { probeServer } from './appServerProbe'
import {
  LOCAL_ENTRY_ID,
  LOCAL_ENTRY_NAME,
  LOG_ROTATE_BYTES,
  LOST_RACE_WAIT_MS,
  PROBE_TIMEOUT_MS,
  READY_TIMEOUT_MS,
  afterStop,
  childEnv,
  localPaths,
  localProfileArgs,
  localProfileName,
  localUrl,
  logTail,
  parseBuildJson,
  probeVerdict,
  resetDecision,
  skewOf,
  spawnFailure,
  type BundledBuild,
  type LocalPaths
} from './localServerRules'
import type { AppServer } from './appServersRules'
import type { LocalServerStatus } from '../shared/types'

/** Set by the smokes that test other things, so they never start a Local server in the user's home. */
export const LOCAL_SERVER_DISABLED = !!process.env.TREK_NO_LOCAL_SERVER
/** `stop --local` waits up to 10 s itself; this bounds the wait for it. */
const STOP_TIMEOUT_MS = 15_000
const POLL_MS = 100

/** The profile this Trek uses: the default one when packaged, `dev` for a dev build (Decision 27). */
const PROFILE = localProfileName(app.isPackaged)
let paths: LocalPaths | null = null
/** The server main is using: from a local.json that probed live. Main only. */
let current: LocalInfo | null = null
let status: LocalServerStatus = { state: 'stopped', message: '', canReset: false }
/** One start, stop, restart or reset at a time; refresh waits its turn behind them. */
let chain: Promise<unknown> = Promise.resolve()
let busy = false
/** Skew already asked about, by pid: one question per server run. */
const askedSkew = new Set<number>()
const listeners = new Set<() => void>()
let watcher: FSWatcher | null = null
let refreshTimer: NodeJS.Timeout | null = null

function profile(): LocalPaths {
  paths ??= localPaths(homedir(), PROFILE)
  return paths
}

/**
 * out/server, beside this bundle's out/main (inside app.asar when packaged). From __dirname,
 * as windows.ts finds the renderer: app.getAppPath() is the folder of out/main/index.js when
 * Electron is given that file (the smokes), not the app root.
 */
const SERVER_DIR = join(__dirname, '..', 'server')

/** The bundled CLI */
export function serverBundle(): string {
  return join(SERVER_DIR, 'trek-server.cjs')
}

function bundledBuild(): BundledBuild | undefined {
  try {
    return parseBuildJson(JSON.parse(readFileSync(join(SERVER_DIR, 'build.json'), 'utf8')))
  } catch {
    return undefined
  }
}

function readInfo(): LocalInfo | undefined {
  try {
    return parseLocalInfo(JSON.parse(readFileSync(profile().info, 'utf8')))
  } catch {
    return undefined
  }
}

function readLock(): { pid: number; mtimeMs: number } | undefined {
  try {
    const text = readFileSync(profile().lock, 'utf8').trim()
    if (!/^\d+$/.test(text)) return undefined
    return { pid: Number(text), mtimeMs: statSync(profile().lock).mtimeMs }
  } catch {
    return undefined
  }
}

function expectedServerId(): string | undefined {
  try {
    const id = (JSON.parse(readFileSync(profile().config, 'utf8')) as { serverId?: unknown }).serverId
    return typeof id === 'string' && id ? id : undefined
  } catch {
    return undefined
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    const done = (open: boolean): void => {
      socket.destroy()
      resolve(open)
    }
    socket.setTimeout(1000, () => done(false))
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
  })
}

/** A hello with local.json's token; the welcome's capabilities and serverId if it is welcomed. */
async function hello(info: LocalInfo): Promise<{ capabilities: string[]; serverId: string } | undefined> {
  const result = await probeServer({
    url: localUrl(info.port),
    token: info.token,
    createSocket: globalSocketFactory,
    clientVersion: app.getVersion(),
    timeoutMs: PROBE_TIMEOUT_MS
  })
  return result.status === 'connected' ? { capabilities: result.capabilities ?? [], serverId: result.serverId ?? '' } : undefined
}

/** local.json probed: usable, or why not. */
async function probe(info = readInfo()): Promise<{ info: LocalInfo } | { why: string }> {
  const alive = !!info && pidAlive(info.pid)
  const welcome = info && alive ? await hello(info) : undefined
  const verdict = probeVerdict({ info, alive, welcome, expectedServerId: expectedServerId() })
  return verdict.use ? { info: info! } : { why: verdict.why }
}

function readLogTail(): string {
  try {
    const fd = openSync(profile().log, 'r')
    try {
      const size = statSync(profile().log).size
      const length = Math.min(size, 64 * 1024)
      const buf = Buffer.alloc(length)
      readSync(fd, buf, 0, length, size - length)
      return logTail(buf.toString('utf8'))
    } finally {
      closeSync(fd)
    }
  } catch {
    return ''
  }
}

function notify(): void {
  for (const l of [...listeners]) {
    try {
      l()
    } catch (err) {
      console.error('trek: a local server listener failed', err)
    }
  }
}

function setStatus(next: LocalServerStatus): void {
  status = next
  notify()
}

function useServer(info: LocalInfo): void {
  current = info
  const skew = skewOf(bundledBuild(), info)
  setStatus({ state: 'running', message: '', canReset: false, pid: info.pid, version: info.version, build: info.build, skew: !!skew })
  if (skew) void offerSkewRestart(info)
}

function fail(message: string, canReset = false): void {
  current = null
  setStatus({ state: 'error', message, canReset })
}

/** Runs `job` after any start, stop, restart or reset in progress. */
function queue<T>(job: () => Promise<T>): Promise<T> {
  const run = chain.then(async () => {
    busy = true
    try {
      return await job()
    } finally {
      busy = false
    }
  })
  chain = run.catch(() => undefined)
  return run
}

/** Opens the log for appending (0600), moving a large one aside first, with a header line. */
function openLog(): number {
  const { dir, log } = profile()
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  try {
    if (statSync(log).size > LOG_ROTATE_BYTES) renameSync(log, `${log}.old`)
  } catch {
    // no log yet
  }
  const fd = openSync(log, 'a', 0o600)
  writeSync(fd, `--- ${new Date().toISOString()} Trek ${app.getVersion()} starts the local server ---\n`)
  return fd
}

/**
 * Spawns `start --local` and waits for its local.json (bounded), an exit 3 (another start
 * holds the lock: use its server once it answers) or another exit (reported, never retried).
 */
async function spawnAndWait(): Promise<void> {
  const bundle = serverBundle()
  if (!existsSync(bundle)) {
    fail(`The bundled server is missing (${bundle}). Run npm run build:server.`)
    return
  }
  setStatus({ state: 'starting', message: '', canReset: false })
  const fd = openLog()
  let exit: number | string | undefined
  let child
  try {
    // detached: its own session (setsid), so no SIGHUP reaches it from the terminal that ran Trek.
    child = spawn(process.execPath, [bundle, 'start', '--local', ...localProfileArgs(PROFILE)], {
      cwd: homedir(),
      detached: true,
      env: childEnv(process.env),
      stdio: ['ignore', fd, fd]
    })
  } catch (err) {
    closeSync(fd)
    fail(`Could not start the local server: ${err instanceof Error ? err.message : String(err)}`)
    return
  }
  closeSync(fd)
  child.once('error', (err) => {
    exit ??= `an error (${err.message})`
  })
  child.once('exit', (code, signal) => {
    exit ??= code ?? signal ?? 'an unknown status'
  })
  child.unref()
  const pid = child.pid

  const deadline = Date.now() + READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    const info = readInfo()
    if (info && info.pid === pid) {
      const found = await probe(info)
      if ('info' in found) {
        useServer(found.info)
        return
      }
    }
    if (exit !== undefined) break
    await sleep(POLL_MS)
  }

  if (exit === undefined) {
    fail(`The local server did not start within ${READY_TIMEOUT_MS / 1000} s (pid ${pid}).\n\n${readLogTail()}`)
    return
  }
  const failure = spawnFailure(exit, readLogTail())
  if (failure.kind === 'lock-held') {
    // Another start won the lock: its local.json may still be on its way.
    const until = Date.now() + LOST_RACE_WAIT_MS
    while (Date.now() < until) {
      const found = await probe()
      if ('info' in found) {
        useServer(found.info)
        return
      }
      await sleep(250)
    }
    const lock = readLock()
    fail(
      `Another process holds the local server's lock (${profile().lock}${lock ? `, pid ${lock.pid}` : ''}), ` +
        'but no local server answers. If no local server is running, Reset local server removes the lock.',
      true
    )
    return
  }
  if (failure.kind === 'lock-error') {
    fail(failure.message)
    return
  }
  fail(`${failure.message}.\n\n${readLogTail()}`)
}

/** Reuses the server local.json names if it answers; otherwise spawns one. */
async function ensure(): Promise<void> {
  const found = await probe()
  if ('info' in found) useServer(found.info)
  else await spawnAndWait()
}

/** Runs the bundled CLI (`stop --local`) to its end; its exit code (null on a timeout) and output. */
function runCli(args: string[]): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    let output = ''
    const child = spawn(process.execPath, [serverBundle(), ...args], { cwd: homedir(), env: childEnv(process.env), stdio: ['ignore', 'pipe', 'pipe'] })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      resolve({ code: null, output })
    }, STOP_TIMEOUT_MS)
    child.stdout.on('data', (d) => (output += d))
    child.stderr.on('data', (d) => (output += d))
    child.once('error', (err) => {
      clearTimeout(timer)
      resolve({ code: null, output: `${output}${err.message}` })
    })
    child.once('exit', (code) => {
      clearTimeout(timer)
      resolve({ code, output })
    })
  })
}

/** `stop --local`; then the target's files are gone, or what is left of them. */
async function stopServer(): Promise<{ code: number | null; output: string; target: number | undefined }> {
  const target = current?.pid ?? readInfo()?.pid
  current = null
  setStatus({ state: 'stopping', message: '', canReset: false })
  const result = await runCli(['stop', '--local', ...localProfileArgs(PROFILE)])
  return { ...result, target }
}

async function stop(): Promise<void> {
  const { code, output } = await stopServer()
  if (code === 0) setStatus({ state: 'stopped', message: 'Stopped from the menu', canReset: false })
  else fail(`Could not stop the local server (stop --local exited ${code ?? 'on a timeout'}).\n\n${output.trim()}`)
}

/** Stop (SIGKILL only the pid both files still name, Notes for 4b 13), then start. */
async function restart(): Promise<void> {
  const { code, output, target } = await stopServer()
  if (target !== undefined) {
    const lock = readLock()
    const next = afterStop({ code, target, lockPid: lock?.pid, infoPid: readInfo()?.pid, alive: pidAlive(target) })
    if (next === 'refuse') {
      fail(`Could not stop the local server (pid ${target}), so it was not restarted.\n\n${output.trim()}`)
      return
    }
    if (next === 'sigkill') {
      process.kill(target, 'SIGKILL')
      const until = Date.now() + 3000
      while (pidAlive(target) && Date.now() < until) await sleep(POLL_MS)
    }
  }
  await spawnAndWait()
}

/** "Reset local server": the lock goes only under resetDecision's rule; then a start. */
async function reset(): Promise<void> {
  const lock = readLock()
  const info = readInfo()
  const welcome = info && pidAlive(info.pid) ? await hello(info) : undefined
  const decision = resetDecision({
    lockPid: lock?.pid,
    lockAlive: lock ? pidAlive(lock.pid) : false,
    lockAgeMs: lock ? Date.now() - lock.mtimeMs : 0,
    info,
    welcomed: !!welcome?.capabilities.includes('local'),
    portOpen: info ? await portOpen(info.port) : false
  })
  if (decision === 'refuse') {
    fail(
      `The lock's process (pid ${lock?.pid}) may be a local server that is still starting or does not respond, ` +
        `so the lock was left alone. Wait a moment and try again, or end that process.`,
      true
    )
    return
  }
  if (decision === 'reset' && lock) {
    // Only the lock judged above: a start that took it meanwhile keeps it.
    if (readLock()?.pid === lock.pid) unlinkSync(profile().lock)
  }
  await ensure()
}

/**
 * local.json changed under us (a hand-run start or stop, a crash, a restart elsewhere):
 * follow it. Waits behind any job in progress, which sets the state itself.
 */
function refresh(): void {
  if (LOCAL_SERVER_DISABLED || busy) return
  void queue(async () => {
    const info = readInfo()
    if (current && info && info.pid === current.pid && info.port === current.port && info.token === current.token && pidAlive(info.pid)) return
    if (!info) {
      if (status.state === 'running') {
        current = null
        setStatus({ state: 'stopped', message: 'The local server is not running', canReset: false })
      }
      return
    }
    const found = await probe(info)
    if ('info' in found) useServer(found.info)
    else if (status.state === 'running') {
      current = null
      setStatus({ state: 'stopped', message: `The local server is not running (${found.why})`, canReset: false })
    }
  })
}

function refreshSoon(): void {
  if (refreshTimer) clearTimeout(refreshTimer)
  refreshTimer = setTimeout(() => {
    refreshTimer = null
    refresh()
  }, 200)
}

/** The skew question, once per server run; declining keeps using it (and says so in the list). */
async function offerSkewRestart(info: LocalInfo): Promise<void> {
  if (askedSkew.has(info.pid)) return
  askedSkew.add(info.pid)
  const skew = skewOf(bundledBuild(), info)
  if (!skew) return
  const what =
    skew.relation === 'older' ? 'an older version' : skew.relation === 'newer' ? 'a newer version' : 'a different build'
  const { response } = await dialog.showMessageBox({
    type: 'question',
    message: `The local server is running ${what} than this Trek.`,
    detail:
      `Running: ${skew.running}\nThis Trek: ${skew.bundled}\n\n` +
      'Restart it with this version? Its terminals close; agent sessions resume when you open their worktrees again.',
    buttons: ['Restart Local Server', 'Keep Running'],
    defaultId: 0,
    cancelId: 1
  })
  if (response === 0 && current?.pid === info.pid) await restartLocalServer()
}

async function showError(): Promise<void> {
  if (status.state !== 'error') return
  const { response } = await dialog.showMessageBox({
    type: 'error',
    message: 'The local server could not start.',
    detail: status.message,
    buttons: status.canReset ? ['Reset Local Server', 'OK'] : ['OK'],
    defaultId: status.canReset ? 1 : 0,
    cancelId: status.canReset ? 1 : 0
  })
  // Queued after the job that showed this dialog (awaiting it here would wait on ourselves).
  if (status.canReset && response === 0) void resetLocalServer()
}

// ---- The API: appServers.ts, the menu, the IPC and quit ----

export function localServerStatus(): LocalServerStatus {
  return { ...status }
}

/** The synthetic entry, listed first; its URL follows the running server. Never persisted. */
export function localEntry(): (AppServer & { local: LocalServerStatus }) | null {
  if (LOCAL_SERVER_DISABLED) return null
  return { id: LOCAL_ENTRY_ID, name: LOCAL_ENTRY_NAME, url: current ? localUrl(current.port) : 'ws://127.0.0.1', local: localServerStatus() }
}

/**
 * The running server's token (main only), checked against local.json first: a file that
 * moved on (or went) gives null now and a refresh, whose URL change re-points the relay
 * and main's connection.
 */
export function localToken(): string | null {
  if (!current) return null
  const info = readInfo()
  if (!info || info.pid !== current.pid || info.port !== current.port || info.token !== current.token) {
    refreshSoon()
    return null
  }
  return current.token
}

/** Every change of status or of the running server. */
export function onLocalServerChanged(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** main's own connection to Local went down, or a window came to the front: look again. */
export function checkLocalServer(): void {
  refreshSoon()
}

export function startLocalServer(): Promise<void> {
  return queue(async () => {
    await ensure()
    await showError()
  })
}

export function stopLocalServer(): Promise<void> {
  return queue(async () => {
    await stop()
    await showError()
  })
}

export function restartLocalServer(): Promise<void> {
  // Queued behind the skew dialog's caller too: never inside another job.
  return queue(async () => {
    if (!current && !readInfo()) await spawnAndWait()
    else await restart()
    await showError()
  })
}

export function resetLocalServer(): Promise<void> {
  return queue(async () => {
    await reset()
    await showError()
  })
}

/** App start: reuse or spawn, then follow local.json. */
export function superviseLocalServer(): Promise<void> {
  if (LOCAL_SERVER_DISABLED) return Promise.resolve()
  try {
    mkdirSync(profile().dir, { recursive: true, mode: 0o700 })
    watcher = watch(profile().dir, (_event, name) => {
      if (name === null || String(name) === 'local.json') refreshSoon()
    })
    watcher.on('error', () => undefined)
  } catch (err) {
    console.warn('trek: cannot watch the local server profile', err)
  }
  return startLocalServer()
}

/** The window actions: the server list's Start/Restart, a Local window's Start, an error's Reset. */
export function registerLocalServerHandlers(): void {
  // Off (the other smokes): no entry, no menu, and no way for a window to start one.
  if (LOCAL_SERVER_DISABLED) return
  ipcMain.handle('localServer:start', () => startLocalServer())
  ipcMain.handle('localServer:restart', () => restartLocalServer())
  ipcMain.handle('localServer:reset', () => resetLocalServer())
}

/** Quit: stop it only when "Stop local server on quit" is on. Never throws. */
export async function quitLocalServer(stopIt: boolean): Promise<void> {
  watcher?.close()
  watcher = null
  if (LOCAL_SERVER_DISABLED || !stopIt) return
  await queue(() => stopServer()).catch((err) => console.error('trek: stopping the local server on quit failed', err))
}
