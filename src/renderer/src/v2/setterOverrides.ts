// The store setters a server window replaces. The reused components edit data
// through store setters (WorktreeDetail selects renameTerminal, QueuePanel
// enqueueTerminalText, NotesPanel setBranchNote, …), so instead of touching
// those call sites, a server window swaps the setters for ones that send the
// edit to the server. Nothing changes locally: the mirror patch does.
//
// The status is the server's alone (it computes it from the pty), so the
// setters that would move it locally (setTerminalStatus, Codex discovery's
// setTerminalSession, saveGlobalSessions' setGlobalSessions) do nothing here.
// So does addWorktreeInstance: every worktree of a server project comes from
// the mirror (AddWorktreeModal's v2 path never calls it).
//
// Pure: windowKind.ts installs the result with useAppStore.setState and puts
// the originals back when the window leaves the server project.
import type { WindowBackend } from '../backend'
import type { AppState } from '../store'

export const OVERRIDDEN_SETTERS = [
  'renameTerminal',
  'toggleTerminalComplete',
  'clearTerminalAttention',
  'setTerminalQueue',
  'enqueueTerminalText',
  'removeQueuedText',
  'setBranchTag',
  'setBranchCustomTag',
  'setBranchNote',
  'setBranchTicket',
  'setBranchPullRequest',
  'setBranchEnvVars',
  'setWorktreeOrder',
  'setTerminalStatus',
  'setTerminalSession',
  'setGlobalSessions',
  'addWorktreeInstance'
] as const

export type OverriddenSetter = (typeof OVERRIDDEN_SETTERS)[number]
export type SetterOverrides = Pick<AppState, OverriddenSetter>

type Slice = Pick<AppState, 'terminals' | 'terminalQueues'>

/**
 * Where a failed request goes, with a title for the dialog: a setter is
 * fire-and-forget, so it has no caller to reject to.
 */
export interface SetterReports {
  /** An acknowledgement (`seen`): skips NOT_CONNECTED, the next show sends it again */
  report(title: string, err: unknown): void
  /** An edit: NOT_CONNECTED says it may not have been saved (`editReporter`) */
  reportEdit(title: string, err: unknown): void
}

export function v2SetterOverrides(backend: WindowBackend, state: () => Slice, reports: SetterReports): SetterOverrides {
  const send = (title: string, request: Promise<void>): void => {
    request.catch((err: unknown) => reports.reportEdit(title, err))
  }
  const noop = (): void => {}
  // `session.seen` already sent and not answered yet: a focus repeated meanwhile sends nothing.
  const seenInFlight = new Set<string>()
  return {
    renameTerminal: (id, title) => send('Could not rename the session', backend.sessions.rename(id, title)),
    toggleTerminalComplete: (id) => {
      const status = state().terminals[id]?.status
      if (!status || status === 'exited') return
      send('Could not update the session', backend.sessions.markComplete(id, status !== 'complete'))
    },
    // Only what `seen` clears: focusTerminal calls this on every click and show.
    clearTerminalAttention: (id) => {
      const status = state().terminals[id]?.status
      if ((status !== 'attention' && status !== 'done') || seenInFlight.has(id)) return
      seenInFlight.add(id)
      backend.sessions
        .seen(id)
        .catch((err: unknown) => reports.report('Could not update the session', err))
        .finally(() => seenInFlight.delete(id))
    },
    setTerminalQueue: (id, texts) => send('Could not update the queue', backend.sessions.setQueue(id, texts)),
    enqueueTerminalText: (id, text) => send('Could not queue the prompt', backend.sessions.enqueue(id, text)),
    removeQueuedText: (id, index) => {
      const queue = state().terminalQueues[id]
      if (!queue || index < 0 || index >= queue.length) return
      send('Could not update the queue', backend.sessions.setQueue(id, queue.filter((_, i) => i !== index)))
    },
    setBranchTag: (repoId, branch, tagId) => send('Could not set the tag', backend.branch.setTag(repoId, branch, tagId)),
    setBranchCustomTag: (repoId, branch, tagId, enabled) =>
      send('Could not set the tag', backend.branch.setCustomTag(repoId, branch, tagId, enabled)),
    setBranchNote: (repoId, branch, text) => send('Could not save the note', backend.branch.setNote(repoId, branch, text)),
    setBranchTicket: (repoId, branch, ticketId) =>
      send('Could not link the ticket', backend.branch.setTicket(repoId, branch, ticketId)),
    setBranchPullRequest: (repoId, branch, url) =>
      send('Could not link the pull request', backend.branch.setPullRequest(repoId, branch, url)),
    setBranchEnvVars: (repoId, branch, text) =>
      send('Could not save the environment', backend.branch.setEnvVars(repoId, branch, text)),
    setWorktreeOrder: (keys) => send('Could not save the worktree order', backend.worktrees.setOrder(keys)),
    setTerminalStatus: noop,
    setTerminalSession: noop,
    setGlobalSessions: noop,
    addWorktreeInstance: noop
  }
}
