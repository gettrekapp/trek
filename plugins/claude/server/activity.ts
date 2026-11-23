// Claude Code's tool calls as they happen (campsite part 4): a session's transcript
// (`historyFile(cwd, sessionId)`, ~/.claude/projects/<cwd>/<id>.jsonl) followed from the server.
// It polls every 2 s until the file exists, and wakes on fs.watch as well where it works (the poll
// keeps going: fs.watch can miss changes). Only what is appended is read, at most 256 KB a wake-up
// (more is read on the next turn); a file there when the watch starts is read from its end, so a
// resumed session's old history isn't replayed, and one that appears later is this run's, read from
// its top. A partial last line waits for the rest; a file that shrinks or is replaced is read again
// from its top. A file busy or locked for a moment (EBUSY, EPERM: Windows) is tried again on the
// next poll, up to FAILS_MAX times in a row; any other error is logged once and ends the watch: the
// hiker falls back to random chores. Sync reads, bounded per wake-up.
import { closeSync, fstatSync, openSync, readSync, statSync, watch as fsWatch } from 'node:fs'
import { StringDecoder } from 'node:string_decoder'
import type { AgentActivity } from '../../../src/shared/plugins/agents.ts'
import { toolsInLine } from '../shared/transcript.ts'
import { historyFile } from './history.ts'

/** How often the file is looked at while nothing wakes the watch */
export const POLL_MS = 2000
/** The most read on one wake-up */
export const READ_MAX = 256 * 1024
/** A line longer than this (a huge Write's content) is skipped, not kept in memory */
export const LINE_MAX = 4 * 1024 * 1024
/** How many polls in a row may find the file busy or locked before the watch gives up */
export const FAILS_MAX = 30

export interface FollowOptions {
  /** A timer (default setTimeout, unref'd) */
  schedule?: (fn: () => void, ms: number) => { cancel(): void }
  /** Wakes `onChange` when the file changes; returns its stop, or null where it can't (default fs.watch) */
  watchFile?: (file: string, onChange: () => void) => (() => void) | null
  warn: (message: string) => void
}

const defaultSchedule = (fn: () => void, ms: number): { cancel(): void } => {
  const timer = setTimeout(fn, ms)
  timer.unref?.()
  return { cancel: () => clearTimeout(timer) }
}

const defaultWatchFile = (file: string, onChange: () => void): (() => void) | null => {
  try {
    const watcher = fsWatch(file, { persistent: false }, () => onChange())
    // A watcher that fails is closed: the poll goes on
    watcher.on('error', () => watcher.close())
    return () => watcher.close()
  } catch {
    return null
  }
}

const codeOf = (err: unknown): string | undefined => (err as { code?: string } | null)?.code
const isMissing = (err: unknown): boolean => codeOf(err) === 'ENOENT'
/** Busy or locked for a moment (an editor, a virus scanner, Windows' share modes): tried again */
const isBusy = (err: unknown): boolean => codeOf(err) === 'EBUSY' || codeOf(err) === 'EPERM'

/**
 * Follows `file`'s complete lines as they are appended, each passed to `onLine`; returns the stop.
 * A throw (onLine's included) is logged once, as `warn`, and stops it.
 */
export function followLines(file: string, onLine: (line: string) => void, options: FollowOptions): () => void {
  const schedule = options.schedule ?? defaultSchedule
  const watchFile = options.watchFile ?? defaultWatchFile
  let stopped = false
  /** Whether the first look has been taken, and whether the file was there then */
  let looked = false
  let thereAtStart = false
  /** Where the next read starts, and which file it is; null: not seen yet (or gone) */
  let pos: number | null = null
  let ino = 0
  let decoder = new StringDecoder('utf8')
  let partial = ''
  /** The rest of a line too long to keep is being skipped */
  let skipping = false
  let timer: { cancel(): void } | null = null
  let unwatch: (() => void) | null = null

  const restart = (at: number, inode: number): void => {
    pos = at
    ino = inode
    decoder = new StringDecoder('utf8')
    partial = ''
    skipping = false
    unwatch?.()
    unwatch = watchFile(file, wake)
  }

  /** Gone (or not there yet): when it comes back it is read from its top */
  const missing = (): false => {
    if (!looked) looked = true
    if (pos !== null) {
      pos = null
      unwatch?.()
      unwatch = null
    }
    return false
  }

  const read = (): boolean => {
    let st
    try {
      st = statSync(file)
    } catch (err) {
      if (!isMissing(err)) throw err
      return missing()
    }
    if (!looked) {
      looked = true
      thereAtStart = true
    }
    if (pos === null) restart(thereAtStart ? st.size : 0, st.ino)
    // Replaced or truncated: read again from the top
    else if (st.ino !== ino || st.size < pos) restart(0, st.ino)
    thereAtStart = false
    const start = pos as number
    if (st.size <= start) return false
    const length = Math.min(st.size - start, READ_MAX)
    const buffer = Buffer.alloc(length)
    let fd: number
    try {
      fd = openSync(file, 'r')
    } catch (err) {
      // Removed between the stat and the open: as if it were missing
      if (isMissing(err)) return missing()
      throw err
    }
    let n: number
    try {
      // The file read may be a newer one than the stat saw: its size and inode are checked again
      if (fstatSync(fd).ino !== ino) return true
      n = readSync(fd, buffer, 0, length, start)
    } finally {
      closeSync(fd)
    }
    pos = start + n
    const lines = (partial + decoder.write(buffer.subarray(0, n))).split('\n')
    partial = lines.pop() ?? ''
    if (skipping && lines.length > 0) {
      lines.shift()
      skipping = false
    }
    if (partial.length > LINE_MAX) {
      partial = ''
      skipping = true
    }
    for (const line of lines) {
      const text = line.endsWith('\r') ? line.slice(0, -1) : line
      if (text.trim() !== '') onLine(text)
    }
    return st.size > (pos as number)
  }

  /** Polls in a row that found the file busy or locked */
  let fails = 0

  function wake(): void {
    if (stopped) return
    let more: boolean
    try {
      more = read()
      fails = 0
    } catch (err) {
      if (isBusy(err) && ++fails < FAILS_MAX) more = false
      else {
        options.warn(`[claude] following ${file} failed; its tool calls are no longer shown: ${err instanceof Error ? err.message : String(err)}`)
        stop()
        return
      }
    }
    if (stopped) return
    timer?.cancel()
    timer = schedule(wake, more ? 0 : POLL_MS)
  }

  function stop(): void {
    stopped = true
    timer?.cancel()
    timer = null
    unwatch?.()
    unwatch = null
  }

  wake()
  return stop
}

/** Claude's tool calls from its sessions' transcripts (the claude plugin's agent `activity`) */
export function claudeActivity(options: FollowOptions): AgentActivity {
  return {
    watch: (session, onTool) =>
      followLines(
        historyFile(session.cwd, session.sessionId),
        (line) => {
          for (const tool of toolsInLine(line)) onTool(tool)
        },
        options
      )
  }
}
