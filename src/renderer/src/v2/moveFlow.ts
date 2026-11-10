// Moving a worktree to another server (phase 5d): the app relays between the two servers'
// connections. Every step is a `move.*` (or `worktree.*`) request; the target builds the worktree
// in one `move.receive`, which undoes itself on failure, and the source removes its copy last, in
// `move.finish`, only if it is unchanged since `move.export`; when it is not, `move.unreceive`
// undoes the target's copy whole. Pure: the requests come in as deps,
// so `node --test` covers it.
import type { MethodNameV2, MethodParamsV2, MethodResultsV2 } from '../../../shared/protocolV2'
import { errorCode, errorText } from './errors.ts'
import type { AppServerLink } from '../../../shared/types'

export type Requester = <M extends MethodNameV2>(method: M, params: MethodParamsV2[M], options?: { timeoutMs?: number }) => Promise<MethodResultsV2[M]>

export const MOVE_STEPS = [
  { key: 'unload', label: 'Stop the sessions on the source' },
  { key: 'export', label: 'Read the uncommitted work and the session histories' },
  { key: 'push', label: 'Push the branch to origin' },
  { key: 'histories', label: 'Copy the session histories' },
  { key: 'receive', label: 'Create the worktree on the target' },
  { key: 'teardown', label: 'Tear down its VM and dev stack on the source' },
  { key: 'finish', label: 'Remove the source worktree' }
] as const

export type MoveStepKey = (typeof MOVE_STEPS)[number]['key']
export type MoveStepStatus = 'pending' | 'active' | 'done' | 'skipped' | 'failed'

/** Each step's time limit: a fetch or a large patch can take longer than the SDK's minute. */
const STEP_MS = 5 * 60_000

export interface MoveFlowDeps {
  source: Requester
  target: Requester
  /** The worktree on the source */
  from: { projectId: string; worktreeId: string }
  /** Where it goes on the target */
  to: { projectId: string; repoId: string }
  /** Its sessions are running: they are stopped first, and started again if the move fails */
  loaded: boolean
  /** The target's welcome capabilities: without `env` the branch's `.env` text is not sent */
  targetCapabilities: readonly string[]
  progress(step: MoveStepKey, status: MoveStepStatus, detail?: string): void
  /** Checked between steps, until the target starts building */
  cancelled(): boolean
  /**
   * The source's Docker VM and dev stack, torn down (the user ticked it) once the target has the
   * worktree and the source is checked unchanged, before its folder goes; never earlier. Shows
   * nothing itself: its warnings come back as notes, and the move goes on (as Delete's does).
   */
  teardown?: () => Promise<string[]>
  /** No teardown because the user unticked it (the step then says so, rather than "nothing to tear down") */
  teardownUnticked?: boolean
}

/**
 * `restored`: the source's sessions, stopped for the move, were started again (true too when none
 * ran); false when that `worktree.load` failed, so the user loads it again by hand.
 */
export type MoveOutcome =
  /** Moved: the target has it, the source's copy is gone */
  | { kind: 'moved'; worktreeId: string; notes: string[] }
  /**
   * Not moved. `undone` false: the target was never changed (the branch may be pushed to origin);
   * true: the target had built it and `move.unreceive` took it back whole. The source is intact.
   */
  | { kind: 'failed'; step: MoveStepKey; error: string; cancelled: boolean; undone: boolean; restored: boolean }
  /** The target has it, and the source's copy stays too (not removed, or the undo was refused) */
  | { kind: 'both'; worktreeId: string; error: string; notes: string[] }
  /**
   * The target may or may not have built it: the connection dropped while it worked. The source is
   * intact and loaded again (if it ran); the user checks the target.
   */
  | { kind: 'unknown'; error: string; restored: boolean }

class Cancelled extends Error {}

/** Bytes in a base64 string */
export function base64Bytes(data: string): number {
  if (!data) return 0
  return (data.length / 4) * 3 - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0)
}

const mb = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(1)} MB`

export async function moveWorktree(deps: MoveFlowDeps): Promise<MoveOutcome> {
  const { source, target, from, to } = deps
  let step: MoveStepKey = 'unload'
  /** The step shown active and not yet ended: a cancel marks it skipped, not left spinning */
  let open: MoveStepKey | null = null
  const progress: MoveFlowDeps['progress'] = (key, status, detail) => {
    open = status === 'active' ? key : open === key ? null : open
    deps.progress(key, status, detail)
  }
  const begin = (next: MoveStepKey): void => {
    if (deps.cancelled()) throw new Cancelled('Cancelled')
    step = next
    progress(next, 'active')
  }
  let unloaded = false
  /** Starts the source's sessions again if the move stopped them; false if that failed */
  const restore = async (): Promise<boolean> => {
    if (!unloaded) return true
    return source('worktree.load', from).then(() => true, () => false)
  }
  let exported: MethodResultsV2['move.export']
  /** The target's staged upload, once begun; dropped on any failure before `move.receive` takes it */
  let transferId: string | undefined
  const abort = async (): Promise<void> => {
    if (transferId) await target('move.abort', { transferId }).catch(() => {})
  }
  try {
    begin('unload')
    if (deps.loaded) {
      await source('worktree.unload', from)
      unloaded = true
      progress('unload', 'done')
    } else progress('unload', 'skipped', 'no sessions running')

    begin('export')
    exported = await source('move.export', from, { timeoutMs: STEP_MS })
    const carried = exported.sessions.length
    progress('export', 'done', `${exported.patch ? 'uncommitted work' : 'no uncommitted work'}, ${carried} session histor${carried === 1 ? 'y' : 'ies'}`)

    begin('push')
    await source('worktree.push', { ...from, setUpstream: true }, { timeoutMs: STEP_MS })
    progress('push', 'done')

    // Each history in its own chunks, one at a time and in order: the target appends at its offset.
    begin('histories')
    if (exported.sessions.length === 0) progress('histories', 'skipped', 'no session history to copy')
    else {
      transferId = (await target('move.begin', to)).transferId
      const total = exported.sessions.reduce((n, s) => n + s.historyBytes, 0)
      let copied = 0
      for (const session of exported.sessions) {
        let offset = 0
        for (;;) {
          if (deps.cancelled()) throw new Cancelled('Cancelled')
          const chunk = await source('move.history', { ...from, agentSessionId: session.agentSessionId, offset }, { timeoutMs: STEP_MS })
          const bytes = base64Bytes(chunk.data)
          if (bytes > 0) await target('move.upload', { transferId, agentSessionId: session.agentSessionId, offset, data: chunk.data }, { timeoutMs: STEP_MS })
          offset += bytes
          copied += bytes
          progress('histories', 'active', `${mb(copied)} of ${mb(total)}`)
          if (chunk.done) break
          if (bytes === 0) throw new Error(`the history of “${session.title}” stopped at ${offset} of ${chunk.total} bytes`)
        }
      }
      progress('histories', 'done', `${exported.sessions.length} session histor${exported.sessions.length === 1 ? 'y' : 'ies'}, ${mb(total)}`)
    }
    begin('receive')
  } catch (err) {
    const cancelled = err instanceof Cancelled
    if (!cancelled) progress(step, 'failed', errorText(err))
    else if (open) progress(open, 'skipped', 'cancelled')
    await abort()
    const restored = await restore()
    return { kind: 'failed', step, error: cancelled ? 'Cancelled' : errorText(err), cancelled, undone: false, restored }
  }

  // From here on there is no cancelling: the target is building it.
  let received: MethodResultsV2['move.receive']
  const kept: string[] = []
  try {
    const { branch, head, patch, sessions } = exported
    let { branchData } = exported
    if (branchData.env && !deps.targetCapabilities.includes('env')) {
      const { env: _env, ...rest } = branchData
      branchData = rest
      kept.push("The branch's Docker .env was not carried: the target server has no environments")
    }
    received = await target('move.receive', { ...to, branch, head, patch, sessions, branchData, ...(transferId ? { transferId } : {}) }, { timeoutMs: STEP_MS })
  } catch (err) {
    progress('receive', 'failed', errorText(err))
    // A refusal undid itself on the target. A lost answer may not have.
    if (errorCode(err) === 'NOT_CONNECTED' || errorCode(err) === 'TIMEOUT') {
      await abort()
      // The source is untouched (nothing finished): it is loaded again whatever the target did.
      return { kind: 'unknown', error: errorText(err), restored: await restore() }
    }
    return { kind: 'failed', step: 'receive', error: errorText(err), cancelled: false, undone: false, restored: await restore() }
  }
  const notes = [...exported.notCarried.map((line) => `Not carried: ${line}`), ...kept, ...received.dropped]
  progress('receive', 'done', received.dropped.length > 0 ? `${received.dropped.length} thing(s) not carried over` : undefined)

  // The point of commitment: the target has it. With a teardown, the source is checked unchanged
  // first (move.finish verifyOnly), so a VM or stack is only destroyed for a move that will finish.
  let tornDown = false
  if (deps.teardown) {
    progress('teardown', 'active')
    try {
      await source('move.finish', { ...from, fingerprint: exported.fingerprint, verifyOnly: true }, { timeoutMs: STEP_MS })
    } catch (err) {
      progress('teardown', 'failed', errorText(err))
      return undoTarget(err, 'teardown')
    }
    const warnings = await deps.teardown().catch((err: unknown) => [errorText(err)])
    notes.push(...warnings)
    tornDown = true
    progress('teardown', warnings.length > 0 ? 'failed' : 'done', warnings.length > 0 ? warnings.join(' ') : undefined)
  } else progress('teardown', 'skipped', deps.teardownUnticked ? 'left in place (unticked)' : 'nothing to tear down')

  progress('finish', 'active')
  try {
    await source('move.finish', { ...from, fingerprint: exported.fingerprint }, { timeoutMs: STEP_MS })
    progress('finish', 'done')
    return { kind: 'moved', worktreeId: received.worktreeId, notes }
  } catch (err) {
    const code = errorCode(err)
    progress('finish', 'failed', errorText(err))
    // Changed or loaded after the copy: the target's copy is stale and goes, unless the source's VM
    // and stack are already gone (then both are kept, for the user to compare).
    if ((code === 'CONFLICT' || code === 'IN_USE') && !tornDown) return undoTarget(err, 'finish')
    if (code === 'CONFLICT' || code === 'IN_USE') {
      return { kind: 'both', worktreeId: received.worktreeId, error: `${errorText(err)}, after its VM and dev stack were torn down: both servers have the worktree now. Compare them and delete one.`, notes }
    }
    return { kind: 'both', worktreeId: received.worktreeId, error: `The target has the worktree, but the source's copy was not removed (${errorText(err)}). Delete it there once you have checked the target.`, notes }
  }

  /**
   * The source changed (or failed its check) after the copy: `move.unreceive` takes the target's
   * copy back whole and the source is loaded again. A refused undo (NOT_FOUND after a target
   * restart or an hour, IN_USE or CONFLICT once the target's copy was loaded or changed) keeps both:
   * no fallback to `worktree.remove`, which could neither be sure the target's copy is unchanged
   * nor put its branch data and histories back.
   */
  async function undoTarget(err: unknown, at: MoveStepKey): Promise<MoveOutcome> {
    const refused = await target('move.unreceive', { projectId: to.projectId, repoId: to.repoId, undoToken: received.undoToken }).then(
      () => null,
      (undoErr: unknown) => errorText(undoErr)
    )
    const restored = await restore()
    if (refused === null) return { kind: 'failed', step: at, error: errorText(err), cancelled: false, undone: true, restored }
    const sessions = restored ? '' : " This worktree's sessions were stopped for the move: load it again."
    return {
      kind: 'both',
      worktreeId: received.worktreeId,
      error: `${errorText(err)}, so the move stopped, but the copy on the target could not be undone (${refused}): both servers have the worktree now, and nothing was removed. Compare them and delete one.${sessions}`,
      notes
    }
  }
}

/**
 * The app's other servers a worktree can move to: every entry but this window's own with a token
 * (main connects only with one). Main's own connection's welcome, when it has one, rules out a
 * server too old for `move`. The web client lists only its own server, so it never offers a move.
 */
export function moveTargets(servers: readonly AppServerLink[] | null, ownEntryId: string): AppServerLink[] {
  return (servers ?? []).filter((s) => s.id !== ownEntryId && s.hasToken && (s.capabilities === undefined || s.capabilities.includes('move')))
}

/** The move this window is running, for its close guard (App.tsx): what the user is told, or null */
let runningMove: string | null = null
export function setRunningMove(detail: string | null): void {
  runningMove = detail
}
export function runningMoveDetail(): string | null {
  return runningMove
}
