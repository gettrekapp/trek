// v2 ptys. Each keeps a ring buffer of recent output (replayed on attach), a
// headless xterm that tracks the screen and terminal modes, and any number of
// attached clients. The pty pauses while any attached client, or the headless
// screen's parser, is congested.
import * as nodePty from 'node-pty'
// @xterm/headless is a webpack CommonJS bundle that sets __esModule. Node ESM
// (tests, tsx) exposes it only as `default`; esbuild's CJS output honours
// __esModule and has no `default`. Take whichever holds the exports.
import * as xtermNamespace from '@xterm/headless'
import type { Terminal as HeadlessTerminal } from '@xterm/headless'
import type { PtyInfo } from '../../../src/shared/protocol'
import type { EventPayloadsV2 } from '../../../src/shared/protocolV2'
import { codedError } from '../errors.ts'
import { MAX_COLS, MAX_ROWS } from './limits.ts'

const { Terminal } = (xtermNamespace as { default?: typeof xtermNamespace }).default ?? xtermNamespace

const RING_BUFFER_LIMIT = 2 * 1024 * 1024
const DRAIN_POLL_MS = 100
const SCROLLBACK = 2000
/** Pause when any attached client has more than this unsent (decision 10, as v1's ptyRegistry). */
export const SINK_HIGH_WATER = 4 * 1024 * 1024
/** Resume when every attached client is below this. */
export const SINK_LOW_WATER = 2 * 1024 * 1024
/**
 * Output written to the headless screen but not parsed yet. @xterm/headless throws
 * ("write data discarded") past ~50 MB, so the pty pauses well before that.
 */
const PARSER_HIGH_WATER = 8 * 1024 * 1024
const PARSER_LOW_WATER = 2 * 1024 * 1024
const KILL_TIMEOUT_MS = 3000
const MAX_SCREEN_LINES = 10_000

export interface PtyProcess {
  onData(cb: (data: string) => void): void
  onExit(cb: (exitCode: number) => void): void
  write(data: string): void
  resize(cols: number, rows: number): void
  /** Without a signal, node-pty sends SIGHUP */
  kill(signal?: string): void
  pause(): void
  resume(): void
}

export interface SpawnOptions {
  file: string
  args: string[]
  cwd: string
  env: Record<string, string>
  cols: number
  rows: number
}

export type PtySpawner = (opts: SpawnOptions) => PtyProcess

/** One client connection, as a receiver of pty events. */
export interface TerminalSink {
  send<E extends 'pty.data' | 'pty.exit'>(event: E, payload: EventPayloadsV2[E]): void
  /** Bytes queued on the connection but not yet sent (a WebSocket's bufferedAmount) */
  bufferedAmount(): number
}

export interface TerminalHostDeps {
  spawner?: PtySpawner
  /** The process ended by itself (not through kill/disposeAll) */
  onExit: (ptyId: string, exitCode: number) => void
  /** How long after kill() a process that is still running gets SIGKILL (default 3000) */
  killTimeoutMs?: number
  /** Live output (never replay), after the chunk is buffered and before clients get it */
  onOutput?: (ptyId: string, data: string) => void
  /** The program rang the terminal bell (from the headless screen) */
  onBell?: (ptyId: string) => void
}

interface PtyRecord {
  ptyId: string
  cwd: string
  cols: number
  rows: number
  proc: PtyProcess
  screen: HeadlessTerminal
  /** Resolves once everything written to `screen` has been parsed */
  parsed: Promise<void>
  /** Characters written to `screen` whose parse callback has not run yet */
  parserPending: number
  /** A screen write failed; logged once, the raw stream carries on */
  screenFailed: boolean
  seq: number
  buffer: string[]
  bufferedLength: number
  bufferStartSeq: number
  sinks: Set<TerminalSink>
  /** Set while the pty is paused; polls until everything drains */
  drainTimer?: NodeJS.Timeout
  /** kill() was called: the pty counts as gone and its exit is not reported to the owner */
  killed: boolean
  /** SIGKILL for a process that outlives kill() */
  killTimer?: NodeJS.Timeout
}

export const nodePtySpawner: PtySpawner = (opts) => {
  const proc = nodePty.spawn(opts.file, opts.args, {
    name: 'xterm-256color',
    cwd: opts.cwd,
    cols: opts.cols,
    rows: opts.rows,
    env: { ...process.env, ...opts.env } as Record<string, string>
  })
  return {
    onData: (cb) => void proc.onData(cb),
    onExit: (cb) => void proc.onExit(({ exitCode }) => cb(exitCode)),
    write: (data) => proc.write(data),
    resize: (cols, rows) => proc.resize(cols, rows),
    kill: (signal) => proc.kill(signal),
    pause: () => proc.pause(),
    resume: () => proc.resume()
  }
}

function validateSize(cols: number, rows: number): void {
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1 || cols > MAX_COLS || rows > MAX_ROWS) {
    throw codedError('BAD_REQUEST', 'cols must be 1–500 and rows 1–200')
  }
}

export class TerminalHost {
  private readonly records = new Map<string, PtyRecord>()
  private readonly spawner: PtySpawner
  private readonly onExit: TerminalHostDeps['onExit']
  private readonly killTimeoutMs: number
  private readonly onOutputHook?: TerminalHostDeps['onOutput']
  private readonly onBellHook?: TerminalHostDeps['onBell']

  constructor(deps: TerminalHostDeps) {
    this.spawner = deps.spawner ?? nodePtySpawner
    this.onExit = deps.onExit
    this.killTimeoutMs = deps.killTimeoutMs ?? KILL_TIMEOUT_MS
    this.onOutputHook = deps.onOutput
    this.onBellHook = deps.onBell
  }

  spawn(ptyId: string, opts: SpawnOptions): void {
    if (this.records.has(ptyId)) throw codedError('BAD_REQUEST', `pty already exists: ${ptyId}`)
    validateSize(opts.cols, opts.rows)
    // The screen first: if its constructor throws, no process is left running.
    // allowProposedApi is required for the buffer API that screen() reads.
    const screen = new Terminal({ cols: opts.cols, rows: opts.rows, scrollback: SCROLLBACK, allowProposedApi: true })
    let proc: PtyProcess
    try {
      proc = this.spawner(opts)
    } catch (err) {
      screen.dispose()
      throw err
    }
    const record: PtyRecord = {
      ptyId,
      cwd: opts.cwd,
      cols: opts.cols,
      rows: opts.rows,
      proc,
      screen,
      parsed: Promise.resolve(),
      parserPending: 0,
      screenFailed: false,
      seq: 0,
      buffer: [],
      bufferedLength: 0,
      bufferStartSeq: 0,
      sinks: new Set(),
      killed: false
    }
    this.records.set(ptyId, record)
    screen.onBell(() => this.safely(() => this.onBellHook?.(ptyId)))
    proc.onData((data) => this.onData(record, data))
    proc.onExit((exitCode) => this.onProcessExit(record, exitCode))
  }

  /** False once the pty has exited or kill() was called. */
  has(ptyId: string): boolean {
    const record = this.records.get(ptyId)
    return record !== undefined && !record.killed
  }

  /**
   * How many ptys the host holds, killed ones included: a killed pty's process may
   * run on until the kill timeout, so it still counts against a pty cap.
   */
  count(): number {
    return this.records.size
  }

  /** Whether `sink` is attached to the pty. */
  isAttached(ptyId: string, sink: TerminalSink): boolean {
    return this.records.get(ptyId)?.sinks.has(sink) ?? false
  }

  /** Last resort at process exit: SIGKILL every pty that is still alive. */
  forceKillAll(): void {
    for (const record of this.records.values()) {
      try {
        record.proc.kill('SIGKILL')
      } catch {
        // already gone
      }
    }
  }

  info(ptyId: string): PtyInfo {
    const r = this.require(ptyId)
    return { ptyId: r.ptyId, cwd: r.cwd, cols: r.cols, rows: r.rows, seq: r.seq }
  }

  /**
   * Replays the scrollback to `sink`, then streams live output to it. A throw leaves it
   * unattached. A connection already above high water gets no replay: it is refused.
   */
  attach(ptyId: string, sink: TerminalSink): PtyInfo {
    const record = this.require(ptyId)
    if (sink.bufferedAmount() > SINK_HIGH_WATER) throw codedError('CONGESTED', 'the connection is congested; try again')
    let seq = record.bufferStartSeq
    for (const data of record.buffer) {
      sink.send('pty.data', { ptyId, seq, data, replay: true })
      seq += data.length
    }
    record.sinks.add(sink)
    this.checkCongested(record)
    return this.info(ptyId)
  }

  detach(ptyId: string, sink: TerminalSink): void {
    const record = this.records.get(ptyId)
    if (record?.sinks.delete(sink)) this.checkDrained(record)
  }

  detachAll(sink: TerminalSink): void {
    for (const record of this.records.values()) {
      if (record.sinks.delete(sink)) this.checkDrained(record)
    }
  }

  write(ptyId: string, data: string): void {
    this.requireLive(ptyId).proc.write(data)
  }

  resize(ptyId: string, cols: number, rows: number): void {
    validateSize(cols, rows)
    const record = this.requireLive(ptyId)
    record.cols = cols
    record.rows = rows
    record.proc.resize(cols, rows)
    record.screen.resize(cols, rows)
  }

  /**
   * Ends the pty (SIGHUP, then SIGKILL if it is still running after the kill
   * timeout); attached clients get pty.exit, the owner does not. A pty already
   * being killed is left alone.
   */
  kill(ptyId: string): void {
    const record = this.require(ptyId)
    if (record.killed) return
    record.killed = true
    record.killTimer = setTimeout(() => {
      if (this.records.get(ptyId) !== record) return
      try {
        record.proc.kill('SIGKILL')
      } catch (err) {
        console.warn(`pty ${ptyId}: SIGKILL failed`, err)
      }
    }, this.killTimeoutMs)
    record.killTimer.unref()
    record.proc.kill()
  }

  disposeAll(): void {
    for (const record of [...this.records.values()]) {
      if (!record.killed) this.kill(record.ptyId)
    }
  }

  /** Whether the program turned on bracketed paste (as of the output parsed so far). */
  bracketedPaste(ptyId: string): boolean {
    return this.require(ptyId).screen.modes.bracketedPasteMode
  }

  /** The last `lines` lines of the screen and scrollback; wrapped lines joined, trailing blanks dropped. */
  screen(ptyId: string, lines: number): string[] {
    if (!Number.isInteger(lines) || lines < 1 || lines > MAX_SCREEN_LINES) {
      throw codedError('BAD_REQUEST', `lines must be an integer from 1 to ${MAX_SCREEN_LINES}`)
    }
    const buffer = this.require(ptyId).screen.buffer.active
    const out: string[] = []
    for (let i = 0; i < buffer.length; i++) {
      const line = buffer.getLine(i)
      if (!line) continue
      // A row that continues on the next one keeps its trailing spaces: they are part of the text.
      const continues = buffer.getLine(i + 1)?.isWrapped === true
      const text = line.translateToString(!continues)
      if (line.isWrapped && out.length > 0) out[out.length - 1] += text
      else out.push(text)
    }
    while (out.length > 0 && out[out.length - 1] === '') out.pop()
    return out.slice(-lines)
  }

  /** Resolves when the headless screen has parsed all output so far (for tests and screen reads). */
  settled(ptyId: string): Promise<void> {
    return this.require(ptyId).parsed
  }

  /** Runs an owner hook; a throwing owner must never break streaming. */
  private safely(fn: () => void): void {
    try {
      fn()
    } catch (err) {
      console.error('terminal host hook failed', err)
    }
  }

  private onData(record: PtyRecord, data: string): void {
    // node-pty can deliver data after the exit event.
    if (this.records.get(record.ptyId) !== record) return
    const seq = record.seq
    record.seq += data.length
    record.buffer.push(data)
    record.bufferedLength += data.length
    while (record.bufferedLength > RING_BUFFER_LIMIT && record.buffer.length > 1) {
      const dropped = record.buffer.shift()!
      record.bufferedLength -= dropped.length
      record.bufferStartSeq += dropped.length
    }
    this.writeScreen(record, data)
    this.safely(() => this.onOutputHook?.(record.ptyId, data))
    for (const sink of [...record.sinks]) {
      try {
        sink.send('pty.data', { ptyId: record.ptyId, seq, data })
      } catch (err) {
        console.warn(`pty ${record.ptyId}: dropping a client after send failed`, err)
        record.sinks.delete(sink)
      }
    }
    this.checkCongested(record)
  }

  /** Feeds the headless screen. A failure there never stops the raw stream. */
  private writeScreen(record: PtyRecord, data: string): void {
    let resolve!: () => void
    const parsed = new Promise<void>((r) => (resolve = r))
    record.parserPending += data.length
    try {
      record.screen.write(data, () => {
        record.parserPending -= data.length
        resolve()
      })
      record.parsed = parsed
    } catch (err) {
      record.parserPending -= data.length
      if (!record.screenFailed) {
        record.screenFailed = true
        console.warn(`pty ${record.ptyId}: the headless screen dropped output`, err)
      }
    }
  }

  /** A sink's unsent bytes; a sink that throws is dropped and counts as 0. */
  private sinkBuffered(record: PtyRecord, sink: TerminalSink): number {
    try {
      return sink.bufferedAmount()
    } catch (err) {
      console.warn(`pty ${record.ptyId}: dropping a client whose buffer could not be read`, err)
      record.sinks.delete(sink)
      return 0
    }
  }

  /** Pauses the pty when the parser or any sink is above high water. */
  private checkCongested(record: PtyRecord): void {
    if (record.drainTimer) return
    let congested = record.parserPending > PARSER_HIGH_WATER
    for (const sink of [...record.sinks]) {
      if (congested) break
      congested = this.sinkBuffered(record, sink) > SINK_HIGH_WATER
    }
    if (!congested) return
    record.proc.pause()
    record.drainTimer = setInterval(() => this.checkDrained(record), DRAIN_POLL_MS)
  }

  /** Resumes a paused pty once the parser and every sink are below low water. */
  private checkDrained(record: PtyRecord): void {
    if (!record.drainTimer) return
    if (record.parserPending >= PARSER_LOW_WATER) return
    for (const sink of [...record.sinks]) {
      if (this.sinkBuffered(record, sink) >= SINK_LOW_WATER) return
    }
    clearInterval(record.drainTimer)
    record.drainTimer = undefined
    record.proc.resume()
  }

  private onProcessExit(record: PtyRecord, exitCode: number): void {
    if (this.records.get(record.ptyId) !== record) return
    clearInterval(record.drainTimer)
    clearTimeout(record.killTimer)
    this.records.delete(record.ptyId)
    for (const sink of record.sinks) {
      try {
        sink.send('pty.exit', { ptyId: record.ptyId, exitCode })
      } catch {
        // the connection is gone
      }
    }
    record.screen.dispose()
    if (record.killed) return
    try {
      this.onExit(record.ptyId, exitCode)
    } catch (err) {
      console.error(`pty ${record.ptyId}: the exit handler failed`, err)
    }
  }

  private require(ptyId: string): PtyRecord {
    const record = this.records.get(ptyId)
    if (!record) throw codedError('PTY_NOT_FOUND', `No such pty: ${ptyId}`)
    return record
  }

  /** As require(), but a pty being killed counts as gone. */
  private requireLive(ptyId: string): PtyRecord {
    const record = this.require(ptyId)
    if (record.killed) throw codedError('PTY_NOT_FOUND', `No such pty: ${ptyId}`)
    return record
  }
}
