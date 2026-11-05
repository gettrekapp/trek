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
  const processingSeen = activity.processingSeen || markers.some((m) => lower.includes(m))
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

// Replies xterm.js sends by itself: cursor position, device attributes,
// status reports, focus in/out, OSC color queries' answers.
const REPLY = /\x1b\[\d+;\d+R|\x1b\[[?>][\d;]*c|\x1b\[\d+n|\x1b\[[IO]|\x1b\]\d+;[^\x07\x1b]*(?:\x07|\x1b\\)/y

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

/** The `attention` topic's entries: sessions in attention or done, oldest first. */
export function attentionEntries(
  projects: Iterable<Project>,
  since: ReadonlyMap<string, number>,
  now: () => number
): AttentionEntry[] {
  const entries: AttentionEntry[] = []
  for (const project of projects) {
    const add = (worktreeId: string | null, s: Project['globalSessions'][number]): void => {
      if (s.status !== 'attention' && s.status !== 'done') return
      entries.push({ projectId: project.id, worktreeId, sessionId: s.id, title: s.title, status: s.status, since: since.get(s.id) ?? now() })
    }
    for (const s of project.globalSessions) add(null, s)
    for (const r of project.repositories) for (const w of r.worktrees) for (const s of w.sessions) add(w.id, s)
  }
  return entries.sort((a, b) => a.since - b.since)
}
