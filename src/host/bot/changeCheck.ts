import type { BotSnapshot } from '../../shared/bot'

/** Terminal status is a guess from output, so only a move into one of these wakes the bot. */
const WAKING_STATUSES = new Set(['done', 'attention', 'exited'])

/** Change lines go into the bot's prompt, so a title or path must stay on its own line. */
const oneLine = (text: string): string => text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').trim()

export function describeChanges(prev: BotSnapshot | null, next: BotSnapshot): string[] {
  if (!prev) return ['First look at this project: nothing has been recorded yet.']
  const changes: string[] = []

  const prevTrees = new Map(prev.worktrees.map((w) => [w.path, w]))
  const nextTrees = new Map(next.worktrees.map((w) => [w.path, w]))
  for (const [path, tree] of nextTrees) {
    const old = prevTrees.get(path)
    if (!old) changes.push(`new worktree ${oneLine(path)} on ${tree.branch ?? 'no branch'}`)
    else if (old.head !== tree.head || old.branch !== tree.branch) {
      changes.push(`worktree ${oneLine(path)} moved to ${tree.branch ?? 'no branch'} at ${tree.head ?? 'unknown'}`)
    }
  }
  for (const path of prevTrees.keys()) {
    if (!nextTrees.has(path)) changes.push(`worktree removed: ${oneLine(path)}`)
  }

  const prevSessions = new Map(prev.sessions.map((s) => [s.id, s]))
  const nextSessions = new Map(next.sessions.map((s) => [s.id, s]))
  for (const [id, session] of nextSessions) {
    const old = prevSessions.get(id)
    if (!old) {
      changes.push(`session "${oneLine(session.title)}" (${id}) started: ${session.status}`)
    } else if (old.status !== session.status && WAKING_STATUSES.has(session.status)) {
      changes.push(`session "${oneLine(session.title)}" (${id}) went from ${old.status} to ${session.status}`)
    }
    const wasWaiting = old?.decision ?? false
    if (!wasWaiting && session.decision) {
      changes.push(`session "${oneLine(session.title)}" (${id}) is waiting on a user decision`)
    } else if (wasWaiting && !session.decision) {
      changes.push(`session "${oneLine(session.title)}" (${id}) decision was answered`)
    }
  }
  for (const [id, session] of prevSessions) {
    if (!nextSessions.has(id)) changes.push(`session "${oneLine(session.title)}" (${id}) ended`)
  }

  if (prev.heartbeat !== next.heartbeat) changes.push('HEARTBEAT.md changed')
  return changes
}
