// The demo's terminals (apps/mobile/src/demo): each holds its scrollback, replays it on attach (as
// `pty.data` with `replay`), echoes what is typed, and plays scripted output a chunk per step.
import type { PtyInfo } from '../shared.ts'
import { DemoError } from './demoError.ts'

/** Who a terminal's output goes to: a demo connection */
export interface PtyListener {
  event(name: string, payload: unknown): void
}

export interface TerminalClock {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

interface Pty {
  id: string
  cwd: string
  cols: number
  rows: number
  /** Characters printed so far (the wire calls it a byte offset; nothing on the phone counts it) */
  seq: number
  buffer: string
  listeners: Set<PtyListener>
  /** The pending step of a play, if one is running */
  play: unknown
}

const MAX_BUFFER = 200_000
const REPLAY_CHUNK = 16_384

/** What a terminal shows for typed input: printable text as is, Enter as a new line, Backspace erasing one; escape sequences (arrow keys) dropped */
export function echo(data: string): string {
  let out = ''
  for (const ch of data.replace(/\r\n/g, '\n').replace(/\u001b\[[0-9;?]*[A-Za-z~]|\u001b./g, '')) {
    if (ch === '\r' || ch === '\n') out += '\r\n'
    else if (ch === '\u007f' || ch === '\b') out += '\b \b'
    else if (ch >= ' ') out += ch
  }
  return out
}

export class DemoTerminals {
  private readonly ptys = new Map<string, Pty>()
  private readonly clock: TerminalClock
  private readonly stepMs: number
  private next = 0

  constructor(clock: TerminalClock, stepMs: number) {
    this.clock = clock
    this.stepMs = stepMs
  }

  /** A new terminal showing `text`; answers its id */
  open(text: string, cwd: string): string {
    const id = `pty-${++this.next}`
    this.ptys.set(id, { id, cwd, cols: 80, rows: 24, seq: 0, buffer: '', listeners: new Set(), play: null })
    this.print(id, text)
    return id
  }

  has(id: string): boolean {
    return this.ptys.has(id)
  }

  /** Ends it (its listeners get `pty.exit`); answers what it showed */
  close(id: string): string {
    const pty = this.ptys.get(id)
    if (!pty) return ''
    this.stopPlay(pty)
    this.ptys.delete(id)
    for (const l of pty.listeners) l.event('pty.exit', { ptyId: id, exitCode: 0 })
    return pty.buffer
  }

  /** Replays the scrollback to `listener`, then streams to it */
  attach(id: string, listener: PtyListener): PtyInfo {
    const pty = this.get(id)
    const start = pty.seq - pty.buffer.length
    for (let i = 0; i < pty.buffer.length; i += REPLAY_CHUNK) {
      listener.event('pty.data', { ptyId: id, seq: start + i, data: pty.buffer.slice(i, i + REPLAY_CHUNK), replay: true })
    }
    pty.listeners.add(listener)
    return { ptyId: id, cwd: pty.cwd, cols: pty.cols, rows: pty.rows, seq: pty.seq }
  }

  detach(id: string, listener: PtyListener): void {
    this.ptys.get(id)?.listeners.delete(listener)
  }

  detachAll(listener: PtyListener): void {
    for (const pty of this.ptys.values()) pty.listeners.delete(listener)
  }

  resize(id: string, cols: number, rows: number): void {
    const pty = this.get(id)
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1) throw new DemoError('BAD_REQUEST', 'Bad terminal size')
    if (pty.cols === cols && pty.rows === rows) return
    pty.cols = cols
    pty.rows = rows
    for (const l of pty.listeners) l.event('pty.resized', { ptyId: id, cols, rows })
  }

  write(id: string, data: string): void {
    this.get(id)
    this.print(id, echo(String(data)))
  }

  print(id: string, text: string): void {
    const pty = this.ptys.get(id)
    if (!pty || !text) return
    const seq = pty.seq
    pty.seq += text.length
    pty.buffer = (pty.buffer + text).slice(-MAX_BUFFER)
    for (const l of pty.listeners) l.event('pty.data', { ptyId: id, seq, data: text })
  }

  /** Prints `chunks` one per step, then calls `done`. A new play on the same terminal, or closing it, cancels this one (its `done` is not called). */
  play(id: string, chunks: string[], done?: () => void): void {
    const pty = this.get(id)
    this.stopPlay(pty)
    let i = 0
    const step = (): void => {
      if (this.ptys.get(id) !== pty) return
      if (i < chunks.length) {
        this.print(id, chunks[i])
        i++
        pty.play = this.clock.setTimeout(step, this.stepMs)
        return
      }
      pty.play = null
      done?.()
    }
    pty.play = this.clock.setTimeout(step, this.stepMs)
  }

  playing(id: string): boolean {
    const pty = this.ptys.get(id)
    return !!pty && pty.play !== null
  }

  dispose(): void {
    for (const pty of this.ptys.values()) this.stopPlay(pty)
    this.ptys.clear()
  }

  private stopPlay(pty: Pty): void {
    if (pty.play === null) return
    this.clock.clearTimeout(pty.play)
    pty.play = null
  }

  private get(id: string): Pty {
    const pty = this.ptys.get(id)
    if (!pty) throw new DemoError('PTY_NOT_FOUND', 'No such terminal')
    return pty
  }
}
