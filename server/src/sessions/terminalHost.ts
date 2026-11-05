// v2 ptys. Each keeps a ring buffer of recent output (replayed on attach), a
// headless xterm that tracks the screen and terminal modes, and any number of
// attached clients. The pty pauses while any attached client is congested.
import * as nodePty from 'node-pty'
// @xterm/headless is a webpack CommonJS bundle that sets __esModule. Node ESM
// (tests, tsx) exposes it only as `default`; esbuild's CJS output honours
// __esModule and has no `default`. Take whichever holds the exports.
import * as xtermNamespace from '@xterm/headless'
import type { Terminal as HeadlessTerminal } from '@xterm/headless'
import type { PtyInfo } from '../../../src/shared/protocol'
import { codedError } from '../errors.ts'

const { Terminal } = (xtermNamespace as { default?: typeof xtermNamespace }).default ?? xtermNamespace

const RING_BUFFER_LIMIT = 2 * 1024 * 1024
const DRAIN_POLL_MS = 100
const SCROLLBACK = 10_000

export interface PtyProcess {
  onData(cb: (data: string) => void): void
  onExit(cb: (exitCode: number) => void): void
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(): void
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
  send(event: 'pty.data' | 'pty.exit', payload: unknown): void
  /** True while the connection has too much unsent data */
  congested(): boolean
}

export interface TerminalHostDeps {
  spawner?: PtySpawner
  /** The process ended by itself (not through kill/disposeAll) */
  onExit: (ptyId: string, exitCode: number) => void
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
  seq: number
  buffer: string[]
  bufferedLength: number
  bufferStartSeq: number
  sinks: Set<TerminalSink>
  drainTimer?: NodeJS.Timeout
  /** kill() was called: the exit is not reported to the owner */
  killed: boolean
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
    kill: () => proc.kill(),
    pause: () => proc.pause(),
    resume: () => proc.resume()
  }
}

export class TerminalHost {
  private readonly records = new Map<string, PtyRecord>()
  private readonly spawner: PtySpawner
  private readonly onExit: TerminalHostDeps['onExit']

  constructor(deps: TerminalHostDeps) {
    this.spawner = deps.spawner ?? nodePtySpawner
    this.onExit = deps.onExit
  }

  spawn(ptyId: string, opts: SpawnOptions): void {
    if (this.records.has(ptyId)) throw new Error(`pty already exists: ${ptyId}`)
    const proc = this.spawner(opts)
    const record: PtyRecord = {
      ptyId,
      cwd: opts.cwd,
      cols: opts.cols,
      rows: opts.rows,
      proc,
      screen: new Terminal({ cols: opts.cols, rows: opts.rows, scrollback: SCROLLBACK, allowProposedApi: true }),
      parsed: Promise.resolve(),
      seq: 0,
      buffer: [],
      bufferedLength: 0,
      bufferStartSeq: 0,
      sinks: new Set(),
      killed: false
    }
    this.records.set(ptyId, record)
    proc.onData((data) => this.onData(record, data))
    proc.onExit((exitCode) => this.onProcessExit(record, exitCode))
  }

  has(ptyId: string): boolean {
    return this.records.has(ptyId)
  }

  info(ptyId: string): PtyInfo {
    const r = this.require(ptyId)
    return { ptyId: r.ptyId, cwd: r.cwd, cols: r.cols, rows: r.rows, seq: r.seq }
  }

  /** Replays the scrollback to `sink`, then streams live output to it. */
  attach(ptyId: string, sink: TerminalSink): PtyInfo {
    const record = this.require(ptyId)
    record.sinks.add(sink)
    let seq = record.bufferStartSeq
    for (const data of record.buffer) {
      sink.send('pty.data', { ptyId, seq, data, replay: true })
      seq += data.length
    }
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
    this.require(ptyId).proc.write(data)
  }

  resize(ptyId: string, cols: number, rows: number): void {
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1 || cols > 1000 || rows > 1000) {
      throw codedError('BAD_REQUEST', 'cols and rows must be integers from 1 to 1000')
    }
    const record = this.require(ptyId)
    record.cols = cols
    record.rows = rows
    record.proc.resize(cols, rows)
    record.screen.resize(cols, rows)
  }

  /** Ends the pty; attached clients get pty.exit, the owner does not. */
  kill(ptyId: string): void {
    const record = this.require(ptyId)
    record.killed = true
    record.proc.kill()
  }

  disposeAll(): void {
    for (const ptyId of [...this.records.keys()]) this.kill(ptyId)
  }

  /** Whether the program turned on bracketed paste (as of the output parsed so far). */
  bracketedPaste(ptyId: string): boolean {
    return this.require(ptyId).screen.modes.bracketedPasteMode
  }

  /** The last `lines` lines of the screen and scrollback; wrapped lines joined, trailing blanks dropped. */
  screen(ptyId: string, lines: number): string[] {
    const buffer = this.require(ptyId).screen.buffer.active
    const out: string[] = []
    for (let i = 0; i < buffer.length; i++) {
      const line = buffer.getLine(i)
      if (!line) continue
      const text = line.translateToString(true)
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

  private onData(record: PtyRecord, data: string): void {
    const seq = record.seq
    record.seq += data.length
    record.buffer.push(data)
    record.bufferedLength += data.length
    while (record.bufferedLength > RING_BUFFER_LIMIT && record.buffer.length > 1) {
      const dropped = record.buffer.shift()!
      record.bufferedLength -= dropped.length
      record.bufferStartSeq += dropped.length
    }
    record.parsed = new Promise<void>((resolve) => record.screen.write(data, resolve))
    let congested = false
    for (const sink of [...record.sinks]) {
      try {
        sink.send('pty.data', { ptyId: record.ptyId, seq, data })
        congested = congested || sink.congested()
      } catch (err) {
        console.warn(`pty ${record.ptyId}: dropping a client after send failed`, err)
        record.sinks.delete(sink)
      }
    }
    if (congested && !record.drainTimer) {
      record.proc.pause()
      record.drainTimer = setInterval(() => this.checkDrained(record), DRAIN_POLL_MS)
    }
  }

  private checkDrained(record: PtyRecord): void {
    if (!record.drainTimer) return
    if ([...record.sinks].some((s) => s.congested())) return
    clearInterval(record.drainTimer)
    record.drainTimer = undefined
    record.proc.resume()
  }

  private onProcessExit(record: PtyRecord, exitCode: number): void {
    if (this.records.get(record.ptyId) !== record) return
    clearInterval(record.drainTimer)
    this.records.delete(record.ptyId)
    for (const sink of record.sinks) {
      try {
        sink.send('pty.exit', { ptyId: record.ptyId, exitCode })
      } catch {
        // the connection is gone
      }
    }
    record.screen.dispose()
    if (!record.killed) this.onExit(record.ptyId, exitCode)
  }

  private require(ptyId: string): PtyRecord {
    const record = this.records.get(ptyId)
    if (!record) throw codedError('PTY_NOT_FOUND', `No such pty: ${ptyId}`)
    return record
  }
}
