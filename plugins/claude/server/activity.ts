// Claude Code's tool calls as they happen (campsite part 4): a session's transcript
// (~/.claude/projects/<cwd>/<id>.jsonl, or under $CLAUDE_CONFIG_DIR) followed from the server.
// Where it is isn't certain (`transcriptFiles`: the cwd resolved or as given, under the config dir
// or ~/.claude: at most 4 paths), so it polls each every 2 s (one stat each) until one exists, then
// follows that one alone; when that one goes, it looks at them all again. It wakes on fs.watch as
// well where it works (the poll keeps going: fs.watch can miss changes). Only what is appended is read, at most 256 KB a wake-up
// (more is read on the next turn); a file there when the watch starts is read from its end, so a
// resumed session's old history isn't replayed, and one that appears later is this run's, read from
// its top; when the followed file goes, another candidate found at once already existed: it too is
// read from its end. A partial last line waits for the rest; a file that shrinks or is replaced is
// read again from its top. A file busy or locked for a moment (EBUSY; EPERM on Windows only, where a
// share mode or a virus scanner causes it) is tried again on the next poll, up to FAILS_MAX polls in
// a row (an fs.watch wake-up that finds it busy doesn't count: the poll comes anyway); any other
// error on the followed file is logged once and ends the watch: the hiker falls back to random
// chores. While searching, a candidate that can't be read is skipped; only when none is there does
// its error count (a busy one as above, any other ends the watch). Sync reads, bounded per wake-up.
import { closeSync, fstatSync, openSync, readSync, statSync, watch as fsWatch, type Stats } from 'node:fs'
import { StringDecoder } from 'node:string_decoder'
import type { AgentActivity } from '../../../src/shared/plugins/agents.ts'
import { toolsInLine } from '../shared/transcript.ts'
import { transcriptFiles } from './history.ts'

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
  /** The platform EPERM is judged on (default process.platform): transient on win32 only */
  platform?: string
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
/** Not there: ENOENT, ENOTDIR (a part of the path is a file), or ENAMETOOLONG (a very long cwd) */
const isMissing = (err: unknown): boolean => ['ENOENT', 'ENOTDIR', 'ENAMETOOLONG'].includes(codeOf(err) ?? '')
/**
 * Busy or locked for a moment, tried again: EBUSY anywhere; EPERM on Windows only (its share modes,
 * a virus scanner), elsewhere a real error
 */
const isBusy = (err: unknown, platform: string): boolean => codeOf(err) === 'EBUSY' || (codeOf(err) === 'EPERM' && platform === 'win32')

/**
 * Follows a file's complete lines as they are appended, each passed to `onLine`; returns the stop.
 * `files`: where it may be, most likely first; the first one found is followed (the others are
 * looked at again only once it is gone). A throw (onLine's included) is logged once, as `warn`, and
 * stops it.
 */
export function followLines(files: string | readonly string[], onLine: (line: string) => void, options: FollowOptions): () => void {
  const schedule = options.schedule ?? defaultSchedule
  const watchFile = options.watchFile ?? defaultWatchFile
  const platform = options.platform ?? process.platform
  const candidates = typeof files === 'string' ? [files] : [...files]
  /** The file followed; null: none found yet (or it went) */
  let file: string | null = null
  let stopped = false
  /** Whether the first look has been taken, and whether the file was there then */
  let looked = false
  let thereAtStart = false
  /** The file just lost (it went): another candidate found at once already existed, read from its end */
  let lost: string | null = null
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
    unwatch = watchFile(file as string, () => wake(false))
  }

  /**
   * Gone (or not there yet): when it comes back it is read from its top. One followed till now is
   * `lost`, and the candidates are looked at again at once (true: wake again now)
   */
  const missing = (): boolean => {
    if (!looked) looked = true
    const was = file
    file = null
    if (pos !== null) {
      pos = null
      unwatch?.()
      unwatch = null
    }
    if (was === null) return false
    lost = was
    return true
  }

  /**
   * Each place it may be, in order: the first there is followed. A candidate whose stat fails
   * otherwise than missing is skipped; only when none is there is the first such error thrown (a
   * real one before a busy one, which the poll tries again)
   */
  const search = (): Stats | undefined => {
    let failed: unknown
    let busy: unknown
    for (const candidate of candidates) {
      try {
        const st = statSync(candidate)
        file = candidate
        return st
      } catch (err) {
        if (isMissing(err)) continue
        if (isBusy(err, platform)) busy ??= err
        else failed ??= err
      }
    }
    if (failed !== undefined) throw failed
    if (busy !== undefined) throw busy
    return undefined
  }

  const read = (): boolean => {
    let st: Stats | undefined
    /** Found right after the followed file went, and not that file again: it already existed */
    let existed = false
    if (file === null) {
      st = search()
      const was = lost
      lost = null
      if (file === null || st === undefined) return missing()
      existed = was !== null && file !== was
    } else {
      try {
        st = statSync(file)
      } catch (err) {
        if (!isMissing(err)) throw err
        return missing()
      }
    }
    if (!looked) {
      looked = true
      thereAtStart = true
    }
    if (pos === null) restart(thereAtStart || existed ? st.size : 0, st.ino)
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
      // Removed between the stat and the open: as if it were missing (looked for again on the next
      // poll, not at once: a stat that keeps finding it mustn't spin)
      if (isMissing(err)) {
        missing()
        return false
      }
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

  /** Polls in a row (the timer's, not fs.watch's wake-ups) that found the file busy or locked */
  let fails = 0

  /** `byPoll`: the timer's (or the first look), not an fs.watch wake-up */
  function wake(byPoll: boolean): void {
    if (stopped) return
    let more: boolean
    try {
      more = read()
      fails = 0
    } catch (err) {
      if (isBusy(err, platform)) {
        // A watch's wake-up doesn't use up the polls: the poll set already tries again
        if (!byPoll) return
        if (++fails < FAILS_MAX) more = false
        else return fail(err)
      } else return fail(err)
    }
    if (stopped) return
    timer?.cancel()
    timer = schedule(() => wake(true), more ? 0 : POLL_MS)
  }

  function fail(err: unknown): void {
    options.warn(`[claude] following ${file ?? candidates.join(', ')} failed; its tool calls are no longer shown: ${err instanceof Error ? err.message : String(err)}`)
    stop()
  }

  function stop(): void {
    stopped = true
    timer?.cancel()
    timer = null
    unwatch?.()
    unwatch = null
  }

  wake(true)
  return stop
}

/** Claude's tool calls from its sessions' transcripts (the claude plugin's agent `activity`) */
export function claudeActivity(options: FollowOptions): AgentActivity {
  return {
    watch: (session, onTool) =>
      followLines(
        transcriptFiles(session.cwd, session.sessionId),
        (line) => {
          for (const tool of toolsInLine(line)) onTool(tool)
        },
        options
      )
  }
}
