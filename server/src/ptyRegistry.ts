import type { WebSocket } from 'ws'
import { PtyService } from '../../src/host/ptyService'
import type { PtyInfo } from '../../src/shared/protocol'

/**
 * PTYs survive client disconnects — that is the point of running on a server.
 * Each pty keeps a ring buffer of recent output so a reattaching client can
 * repaint, and at most one attached socket receives live data. Only pty.kill
 * or daemon shutdown ends a session.
 */

const RING_BUFFER_LIMIT = 2 * 1024 * 1024 // ~2 MiB of scrollback per pty
const BACKPRESSURE_HIGH = 4 * 1024 * 1024 // pause pty when socket buffers this much
const BACKPRESSURE_POLL_MS = 100

interface PtyRecord {
  ptyId: string
  cwd: string
  cols: number
  rows: number
  /** Cumulative length of all output ever emitted. */
  seq: number
  /** Recent output chunks; total length capped at RING_BUFFER_LIMIT. */
  buffer: string[]
  bufferedLength: number
  /** seq offset of buffer[0]'s first char. */
  bufferStartSeq: number
  attached: WebSocket | null
  drainTimer: NodeJS.Timeout | null
}

export interface PtyEventSink {
  send(ws: WebSocket, event: string, payload: unknown): void
}

export class PtyRegistry {
  private ptys = new PtyService()
  private records = new Map<string, PtyRecord>()

  constructor(private sink: PtyEventSink) {}

  spawn(
    opts: {
      ptyId: string
      cwd: string
      command?: string
      env?: Record<string, string>
      cols: number
      rows: number
    },
    ws: WebSocket
  ): void {
    if (this.records.has(opts.ptyId)) {
      throw new Error(`pty already exists: ${opts.ptyId}`)
    }
    const record: PtyRecord = {
      ptyId: opts.ptyId,
      cwd: opts.cwd,
      cols: opts.cols,
      rows: opts.rows,
      seq: 0,
      buffer: [],
      bufferedLength: 0,
      bufferStartSeq: 0,
      attached: ws,
      drainTimer: null
    }
    this.records.set(opts.ptyId, record)

    this.ptys.spawn(
      {
        id: opts.ptyId,
        cwd: opts.cwd,
        command: opts.command,
        env: opts.env,
        cols: opts.cols,
        rows: opts.rows
      },
      {
        onData: (data) => this.onData(record, data),
        onExit: (exitCode) => {
          this.clearDrainTimer(record)
          this.records.delete(record.ptyId)
          if (record.attached && record.attached.readyState === record.attached.OPEN) {
            this.sink.send(record.attached, 'pty.exit', { ptyId: record.ptyId, exitCode })
          }
        }
      }
    )
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

    const ws = record.attached
    if (ws && ws.readyState === ws.OPEN) {
      this.sink.send(ws, 'pty.data', { ptyId: record.ptyId, seq, data })
      if (ws.bufferedAmount > BACKPRESSURE_HIGH && !record.drainTimer) {
        this.ptys.pause(record.ptyId)
        record.drainTimer = setInterval(() => {
          const attached = record.attached
          if (!attached || attached.readyState !== attached.OPEN || attached.bufferedAmount < BACKPRESSURE_HIGH / 2) {
            this.clearDrainTimer(record)
            this.ptys.resume(record.ptyId)
          }
        }, BACKPRESSURE_POLL_MS)
      }
    }
  }

  private clearDrainTimer(record: PtyRecord): void {
    if (record.drainTimer) {
      clearInterval(record.drainTimer)
      record.drainTimer = null
    }
  }

  /** Attach a socket and replay the ring buffer to it. */
  attach(ptyId: string, ws: WebSocket): PtyInfo {
    const record = this.mustGet(ptyId)
    record.attached = ws
    let seq = record.bufferStartSeq
    for (const chunk of record.buffer) {
      this.sink.send(ws, 'pty.data', { ptyId, seq, data: chunk, replay: true })
      seq += chunk.length
    }
    return this.info(record)
  }

  detach(ptyId: string, ws: WebSocket): void {
    const record = this.records.get(ptyId)
    if (record && record.attached === ws) {
      record.attached = null
      this.clearDrainTimer(record)
      this.ptys.resume(ptyId)
    }
  }

  /** Called when a socket closes — detach everywhere, keep ptys running. */
  detachAll(ws: WebSocket): void {
    for (const record of this.records.values()) {
      if (record.attached === ws) {
        record.attached = null
        this.clearDrainTimer(record)
        this.ptys.resume(record.ptyId)
      }
    }
  }

  write(ptyId: string, data: string): void {
    this.mustGet(ptyId)
    this.ptys.write(ptyId, data)
  }

  resize(ptyId: string, cols: number, rows: number): void {
    const record = this.mustGet(ptyId)
    record.cols = cols
    record.rows = rows
    this.ptys.resize(ptyId, cols, rows)
  }

  kill(ptyId: string): void {
    const record = this.mustGet(ptyId)
    this.clearDrainTimer(record)
    this.ptys.dispose(ptyId)
    this.records.delete(ptyId)
  }

  list(): PtyInfo[] {
    return [...this.records.values()].map((r) => this.info(r))
  }

  disposeAll(): void {
    for (const record of this.records.values()) this.clearDrainTimer(record)
    this.records.clear()
    this.ptys.disposeAll()
  }

  private info(record: PtyRecord): PtyInfo {
    return {
      ptyId: record.ptyId,
      cwd: record.cwd,
      cols: record.cols,
      rows: record.rows,
      seq: record.seq
    }
  }

  private mustGet(ptyId: string): PtyRecord {
    const record = this.records.get(ptyId)
    if (!record) {
      const err = new Error(`No such pty: ${ptyId}`)
      ;(err as NodeJS.ErrnoException).code = 'PTY_NOT_FOUND'
      throw err
    }
    return record
  }
}
