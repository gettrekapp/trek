// Session status from live terminal activity — the desktop's rules
// (src/renderer/src/terminals.ts markActivity / onBell / onKey), ported as pure
// functions. The SessionManager owns the timers and applies the results.
import type { AttentionEntry, Project, SessionStatus } from '../../../src/shared/model/types'

/** Output must stay quiet this long before a working session settles. */
export const IDLE_MS = 2500

export interface Activity {
  /** A provider marker ("esc to interrupt") was seen since the last settle */
  processingSeen: boolean
  /** The end of the previous chunk, so a marker split across chunks still matches */
  scanTail: string
}

export function newActivity(): Activity {
  return { processingSeen: false, scanTail: '' }
}

/** Live (never replayed) output. `restartTimer`: (re)start the quiet timer. */
export function onOutput(
  status: SessionStatus,
  activity: Activity,
  data: string,
  markers: readonly string[]
): { status: SessionStatus; activity: Activity; restartTimer: boolean } {
  // Marked complete: the user opted out of tracking.
  if (status === 'complete') return { status, activity, restartTimer: false }
  const window = activity.scanTail + data
  const lower = window.toLowerCase()
  const processingSeen = activity.processingSeen || markers.some((m) => lower.includes(m.toLowerCase()))
  const longest = Math.max(1, ...markers.map((m) => m.length))
  const next: Activity = { processingSeen, scanTail: window.slice(Math.max(0, window.length - longest + 1)) }
  // A bell means the agent waits on the user: redraws must not clear it.
  const nextStatus = status === 'attention' || status === 'exited' ? status : 'working'
  return { status: nextStatus, activity: next, restartTimer: true }
}

/** The quiet timer fired. */
export function onQuiet(status: SessionStatus, activity: Activity): { status: SessionStatus; activity: Activity } {
  if (status !== 'working') return { status, activity }
  return { status: activity.processingSeen ? 'done' : 'idle', activity: { ...activity, processingSeen: false } }
}

/** The terminal rang its bell (a BEL ending an OSC sequence is not a bell). */
export function onBell(status: SessionStatus): SessionStatus {
  return status === 'complete' || status === 'exited' ? status : 'attention'
}

/** The user typed into the session. */
export function onInput(status: SessionStatus): SessionStatus {
  return status === 'attention' || status === 'complete' ? 'working' : status
}

// What xterm.js sends without the user typing: replies to the program's
// queries (cursor position and DECXCPR, device attributes, status and mode
// reports, DECRQSS, window reports, OSC color answers), focus in/out, and mouse
// reports (the desktop's onKey never counted those, and pointer motion must not
// clear attention). Shift/Ctrl/Alt+F3 sends ESC[1;<mod>R, which is byte-for-byte
// a cursor report, so that key is not seen as input.
const QUERY_REPLY_SOURCE =
  /\x1b\[\??\d+;\d+R|\x1b\[[?>][\d;]*c|\x1b\[\d+n|\x1b\[\??\d+;\d+\$y|\x1bP[01]\$r[^\x1b]*\x1b\\|\x1b\[[468];\d+;\d+t|\x1b\[[IO]|\x1b\]\d+;[^\x07\x1b]*(?:\x07|\x1b\\)/.source
const MOUSE_REPORT_SOURCE = /\x1b\[<\d+;\d+;\d+[Mm]|\x1b\[M[\s\S]{3}/.source
const REPLY = new RegExp(`${QUERY_REPLY_SOURCE}|${MOUSE_REPORT_SOURCE}`, 'y')

/** True when `data` is only terminal replies (or empty): not the user typing. */
export function isTerminalReply(data: string): boolean {
  let at = 0
  while (at < data.length) {
    REPLY.lastIndex = at
    if (!REPLY.test(data)) return false
    at = REPLY.lastIndex
  }
  return true
}

// The query replies of REPLY, without its mouse reports: answers to a query the program sent
// (cursor position and DECXCPR, device attributes, status and mode reports, DECRQSS, window
// reports, OSC colour answers) and focus in/out, what every attached terminal sends on its own.
// The server's headless screen never answers, so one client must; with several attached, only the
// pty's reply owner's get through (TerminalHost.writeFrom). Mouse reports are the user acting,
// from whichever client.
const QUERY_REPLY = new RegExp(QUERY_REPLY_SOURCE, 'y')

/** True when `data` is only query replies (and focus reports), and not empty. */
export function isQueryReply(data: string): boolean {
  if (data === '') return false
  let at = 0
  while (at < data.length) {
    QUERY_REPLY.lastIndex = at
    if (!QUERY_REPLY.test(data)) return false
    at = QUERY_REPLY.lastIndex
  }
  return true
}

/**
 * The `attention` topic's entries: sessions in attention or done, or with an open decision, and
 * worktrees with a pull request notice (5c-1), oldest first.
 * A flagged session with no `since` yet gets now, stored into `since` so it stays the same on the next publish.
 */
export function attentionEntries(
  projects: Iterable<Project>,
  since: Map<string, number>,
  now: () => number
): AttentionEntry[] {
  const entries: AttentionEntry[] = []
  const fallback = now()
  const sinceOf = (sessionId: string): number => {
    const known = since.get(sessionId)
    if (known !== undefined) return known
    since.set(sessionId, fallback)
    return fallback
  }
  for (const project of projects) {
    const add = (worktreeId: string | null, s: Project['globalSessions'][number]): void => {
      const flagged = s.status === 'attention' || s.status === 'done'
      if (!flagged && !s.decision) return
      const entry: AttentionEntry = {
        projectId: project.id,
        worktreeId,
        sessionId: s.id,
        title: s.title,
        status: s.status,
        since: flagged ? sinceOf(s.id) : s.decision!.at,
        projectName: project.name
      }
      if (s.decision) entry.decision = s.decision
      if (project.settings.audioAlerts === true) entry.audioAlerts = true
      entries.push(entry)
    }
    for (const s of project.globalSessions) add(null, s)
    for (const r of project.repositories) {
      for (const w of r.worktrees) {
        for (const s of w.sessions) add(w.id, s)
        // A watched pull request's notice (5c-1): the worktree's entry, with no session.
        if (w.prNotice) {
          const n = w.prNotice
          const entry: AttentionEntry = {
            projectId: project.id,
            worktreeId: w.id,
            sessionId: '',
            title: n.title,
            status: 'attention',
            since: n.at,
            projectName: project.name,
            pullRequest: { text: n.text, url: n.url }
          }
          if (project.settings.audioAlerts === true) entry.audioAlerts = true
          entries.push(entry)
        }
      }
    }
  }
  return entries.sort((a, b) => a.since - b.since)
}
