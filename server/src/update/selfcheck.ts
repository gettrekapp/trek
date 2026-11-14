// `trek-server selfcheck`: can this install run here? node-pty loads (on macOS a quarantined or
// unsigned one does not), a terminal runs a command, and a server on a loopback port the OS picks
// answers one connection. Everything it writes is in a temp folder of its own: the real config
// and data are never read. `trek-server update` runs the new version's selfcheck before it
// replaces the old one, and the tarball smoke runs it too.
import { mkdtempSync, rmSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'
import { PROTOCOL_VERSION_V2 } from '../../../src/shared/protocolV2.ts'
import { buildInfo } from '../buildInfo.ts'
import { saveConfig } from '../config.ts'
import { ConfigStore } from '../configStore.ts'
import { ProjectState } from '../projects/state.ts'
import { ProjectStore } from '../projects/store.ts'
import { startServer } from '../server.ts'
import { loadNodePty } from '../sessions/nativePty.ts'
import { addToken } from '../tokens.ts'

export interface SelfcheckStep {
  name: string
  ok: boolean
  error?: string
}

export interface SelfcheckResult {
  ok: boolean
  steps: SelfcheckStep[]
  /** The temp folder it used (removed by the time this returns) */
  workDir: string
}

/** What the check uses of a WebSocket (the tests stand in for it) */
export interface SelfcheckSocket {
  addEventListener(type: 'open' | 'message' | 'error' | 'close', listener: (event: { data?: unknown }) => void): void
  send(data: string): void
  close(): void
}

export interface SelfcheckOptions {
  log?: (line: string) => void
  /** For the tests: stands in for loading node-pty */
  loadPty?: () => Pty
  /** For the tests: stands in for the WebSocket to the throwaway server */
  openSocket?: (url: string) => SelfcheckSocket
  /** How long each step may take (default 10 s) */
  stepTimeoutMs?: number
}

type Pty = Pick<ReturnType<typeof loadNodePty>, 'spawn'>
/** What a step started that must not outlive the check: run, newest first, however the check ends. */
type Cleanups = Array<() => void | Promise<void>>

const STEP_TIMEOUT_MS = 10_000
/** How long the throwaway server's port may take to close before the check stops waiting for it */
const CLOSE_WAIT_MS = 2000

function within<T>(what: string, ms: number, promise: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what}: no answer in ${ms / 1000} s`)), ms)
    promise.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (err: unknown) => { clearTimeout(timer); reject(err) }
    )
  })
}

/** A shell prints a marker in a pty and exits 0. One that has not exited when the check ends is killed. */
function runInTerminal(pty: Pty, cwd: string, cleanups: Cleanups): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    // As the server starts a session's (sessions/terminalHost.ts): the same terminal name and environment.
    const term = pty.spawn('/bin/sh', ['-c', 'echo trek-selfcheck-$((40 + 2))'], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd,
      env: process.env as Record<string, string>
    })
    let exited = false
    cleanups.push(() => {
      if (!exited) term.kill()
    })
    let output = ''
    term.onData((data) => { output += data })
    term.onExit(({ exitCode }) => {
      exited = true
      if (exitCode === 0 && output.includes('trek-selfcheck-42')) resolve()
      else reject(new Error(`the shell exited ${exitCode} and printed ${JSON.stringify(output.slice(0, 200))}`))
    })
  })
}

const realSocket = (url: string): SelfcheckSocket => {
  const ws = new WebSocket(url)
  return {
    addEventListener: (type, listener) => ws.addEventListener(type, (event: object) => listener(event)),
    send: (data) => ws.send(data),
    close: () => ws.close()
  }
}

/** A server on 127.0.0.1, a port the OS picks: one hello with a token made for it is answered with a welcome. */
async function serverAnswers(workDir: string, cleanups: Cleanups, openSocket: (url: string) => SelfcheckSocket): Promise<void> {
  const configPath = join(workDir, 'config.json')
  saveConfig(configPath, { repos: [] })
  const store = new ConfigStore(configPath)
  let token = ''
  store.update((config) => { token = addToken(config, 'selfcheck') })
  const files = new ProjectStore(join(workDir, 'projects'))
  // No MCP, history, machine, integrations, plugins, push or web: nothing outside workDir is read
  // or written, nothing but the loopback port is opened, and what another server left in the temp
  // directory is not swept (that server may be the one in use).
  const server = startServer(
    store,
    buildInfo().version,
    { create: (hub, onSummariesChange) => new ProjectState({ hub, store: files, onSummariesChange }, files.loadAll()), store: files },
    { sweepStaleMoves: false }
  )
  let over = false
  cleanups.push(async () => {
    over = true
    const { httpServer } = server
    // Its port is free again by the time the check returns (or CLOSE_WAIT_MS have passed).
    const closed = httpServer.listening
      ? new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, CLOSE_WAIT_MS)
          httpServer.once('close', () => { clearTimeout(timer); resolve() })
        })
      : Promise.resolve()
    await server.shutdown('selfcheck')
    httpServer.closeAllConnections()
    server.sessions.terminals.forceKillAll()
    store.close()
    files.close()
    await closed
  })
  await new Promise<void>((resolve, reject) => {
    server.httpServer.once('error', reject)
    server.httpServer.listen(0, '127.0.0.1', resolve)
  })
  if (over) return
  const { port } = server.httpServer.address() as AddressInfo
  await new Promise<void>((resolve, reject) => {
    const ws = openSocket(`ws://127.0.0.1:${port}`)
    cleanups.push(() => ws.close())
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ type: 'hello', protocolVersion: PROTOCOL_VERSION_V2, token, client: 'trek-server-selfcheck', clientVersion: buildInfo().version }))
    })
    ws.addEventListener('message', (event) => {
      let frame: { type?: unknown } = {}
      try {
        frame = JSON.parse(String(event.data))
      } catch {
        // Not JSON: not a welcome.
      }
      if (frame !== null && typeof frame === 'object' && frame.type === 'welcome') resolve()
      else reject(new Error(`the server answered ${String(event.data).slice(0, 200)} instead of a welcome`))
    })
    ws.addEventListener('error', () => reject(new Error('the WebSocket connection failed')))
    ws.addEventListener('close', () => reject(new Error('the server closed the connection before a welcome')))
  })
}

/** Runs the three checks in order, stopping at the first that fails. */
export async function selfcheck(opts: SelfcheckOptions = {}): Promise<SelfcheckResult> {
  const log = opts.log ?? ((line: string) => console.log(line))
  const timeout = opts.stepTimeoutMs ?? STEP_TIMEOUT_MS
  const workDir = mkdtempSync(join(tmpdir(), 'trek-selfcheck-'))
  const steps: SelfcheckStep[] = []
  const cleanups: Cleanups = []
  let pty: Pty | undefined
  const step = async (name: string, run: () => Promise<void> | void): Promise<boolean> => {
    try {
      await within(name, timeout, Promise.resolve().then(run))
      steps.push({ name, ok: true })
      log(`ok: ${name}`)
      return true
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      steps.push({ name, ok: false, error })
      log(`FAIL: ${name}\n  ${error}`)
      return false
    }
  }
  try {
    const passed =
      (await step('node-pty loads', () => { pty = (opts.loadPty ?? loadNodePty)() })) &&
      (await step('a terminal runs a command', () => runInTerminal(pty!, workDir, cleanups))) &&
      (await step('the server answers a connection', () => serverAnswers(workDir, cleanups, opts.openSocket ?? realSocket)))
    return { ok: passed, steps, workDir }
  } finally {
    // A step that failed or timed out may have left a shell, a socket or the server running.
    for (const cleanup of cleanups.reverse()) {
      try {
        await cleanup()
      } catch {
        // The rest still has to stop, and the folder to go.
      }
    }
    rmSync(workDir, { recursive: true, force: true })
  }
}

/** The command: exit 0 when this install can run, 1 when it cannot. */
export async function runSelfcheckCommand(): Promise<number> {
  const { version, build } = buildInfo()
  console.log(`trek-server ${version} (build ${build}) selfcheck`)
  // stdout carries the steps and nothing else (`trek-server update` shows it): what the throwaway
  // server logs (a connection, a warning) goes to stderr.
  const out = console.log
  console.log = (...args: unknown[]) => console.error(...args)
  try {
    const result = await selfcheck({ log: (line) => out(line) })
    return result.ok ? 0 : 1
  } finally {
    console.log = out
  }
}
