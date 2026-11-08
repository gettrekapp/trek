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
// the mirror (AddWorktreeModal's v2 path never calls it). Decisions are the
// server's too: only its MCP opens one (requestDecision does nothing), any
// input the server counts closes it, and a dismiss (clearDecision, from
// DecisionIcon and NotificationsMenu) asks the server; none is cleared here.
//
// Pure: windowKind.ts installs the result with useAppStore.setState and puts
// the originals back when the window leaves the server project.
import { errorCode } from './errors.ts'
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
  'setWorktreeOrder',
  'setTerminalStatus',
  'setTerminalSession',
  'setGlobalSessions',
  'addWorktreeInstance',
  'requestDecision',
  'clearDecision'
] as const

export type OverriddenSetter = (typeof OVERRIDDEN_SETTERS)[number]
export type SetterOverrides = Pick<AppState, OverriddenSetter>

type Slice = Pick<AppState, 'terminals' | 'terminalQueues' | 'decisions'>

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

/**
 * Where `text`, last seen at `index`, is in `queue` now: still at `index` if it
 * is there, else its first occurrence; -1 once it is gone.
 */
export function refindQueued(queue: readonly string[] | undefined, index: number, text: string): number {
  if (!queue) return -1
  if (queue[index] === text) return index
  return queue.indexOf(text)
}

export function v2SetterOverrides(backend: WindowBackend, state: () => Slice, reports: SetterReports): SetterOverrides {
  const send = (title: string, request: Promise<void>): void => {
    request.catch((err: unknown) => reports.reportEdit(title, err))
  }
  const noop = (): void => {}
  // `session.seen` already sent and not answered yet: a focus repeated meanwhile sends nothing.
  const seenInFlight = new Set<string>()
  // Likewise a dismiss: the decision stays shown until the server's patch removes it.
  const dismissInFlight = new Set<string>()
  return {
    renameTerminal: (id, title, expected) =>
      send('Could not rename the session', backend.sessions.rename(id, title, expected)),
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
    // Sent with the prompt the user saw there. On a CONFLICT another client
    // changed the queue first, and the store already holds its newer queue:
    // the prompt is looked up there again and, if it is still queued, removed
    // once more from where it now is (QueuePanel has typed it already, so it
    // must not stay queued). A second CONFLICT needs no dialog, the queue
    // shown is about to change anyway.
    removeQueuedText: (id, index) => {
      const queue = state().terminalQueues[id]
      if (!queue || index < 0 || index >= queue.length) return
      const expected = queue[index]
      const failed = (err: unknown): void => {
        if (errorCode(err) !== 'CONFLICT') reports.reportEdit('Could not update the queue', err)
      }
      backend.sessions.dequeue(id, index, expected).catch((err: unknown) => {
        if (errorCode(err) !== 'CONFLICT') return failed(err)
        const again = refindQueued(state().terminalQueues[id], index, expected)
        if (again < 0) return
        backend.sessions.dequeue(id, again, expected).catch(failed)
      })
    },
    setBranchTag: (repoId, branch, tagId) => send('Could not set the tag', backend.branch.setTag(repoId, branch, tagId)),
    setBranchCustomTag: (repoId, branch, tagId, enabled) =>
      send('Could not set the tag', backend.branch.setCustomTag(repoId, branch, tagId, enabled)),
    setBranchNote: (repoId, branch, text) => send('Could not save the note', backend.branch.setNote(repoId, branch, text)),
    setBranchTicket: (repoId, branch, ticketId) =>
      send('Could not link the ticket', backend.branch.setTicket(repoId, branch, ticketId)),
    setBranchPullRequest: (repoId, branch, url) =>
      send('Could not link the pull request', backend.branch.setPullRequest(repoId, branch, url)),
    setWorktreeOrder: (keys) => send('Could not save the worktree order', backend.worktrees.setOrder(keys)),
    setTerminalStatus: noop,
    setTerminalSession: noop,
    setGlobalSessions: noop,
    addWorktreeInstance: noop,
    requestDecision: noop,
    clearDecision: (id) => {
      if (!state().decisions[id] || dismissInFlight.has(id)) return
      dismissInFlight.add(id)
      backend.sessions
        .dismissDecision(id)
        .catch((err: unknown) => reports.report('Could not dismiss the decision', err))
        .finally(() => dismissInFlight.delete(id))
    }
  }
}
