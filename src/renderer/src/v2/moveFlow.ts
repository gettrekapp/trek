// Moving a worktree to another server (phase 5d): the app relays between the two servers'
// connections. Every step is a `move.*` (or `worktree.*`) request; the target builds the worktree
// in one `move.receive`, which undoes itself on failure, and the source removes its copy last, in
// `move.finish`, only if it is unchanged since `move.export`. Pure: the requests come in as deps,
// so `node --test` covers it.
import type { MethodNameV2, MethodParamsV2, MethodResultsV2 } from '../../../shared/protocolV2'
import { errorCode, errorText } from './errors.ts'
import type { AppServerLink } from '../../../shared/types'

export type Requester = <M extends MethodNameV2>(method: M, params: MethodParamsV2[M], options?: { timeoutMs?: number }) => Promise<MethodResultsV2[M]>

export const MOVE_STEPS = [
  { key: 'unload', label: 'Stop the sessions on the source' },
  { key: 'export', label: 'Read the uncommitted work and the session histories' },
  { key: 'push', label: 'Push the branch to origin' },
  { key: 'receive', label: 'Create the worktree on the target' },
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
  progress(step: MoveStepKey, status: MoveStepStatus, detail?: string): void
  /** Checked between steps, until the target starts building */
  cancelled(): boolean
}

export type MoveOutcome =
  /** Moved: the target has it, the source's copy is gone */
  | { kind: 'moved'; worktreeId: string; notes: string[] }
  /** Nothing changed on either server (the source's sessions are started again if they ran) */
  | { kind: 'failed'; step: MoveStepKey; error: string }
  /** The target has it, but the source's copy could not be removed: both exist */
  | { kind: 'both'; worktreeId: string; error: string; notes: string[] }
  /** The target may or may not have built it: the connection dropped while it worked */
  | { kind: 'unknown'; error: string }

class Cancelled extends Error {}

export async function moveWorktree(deps: MoveFlowDeps): Promise<MoveOutcome> {
  const { source, target, from, to } = deps
  let step: MoveStepKey = 'unload'
  const begin = (next: MoveStepKey): void => {
    if (deps.cancelled()) throw new Cancelled('Cancelled')
    step = next
    deps.progress(next, 'active')
  }
  let unloaded = false
  const restore = async (): Promise<void> => {
    if (unloaded) await source('worktree.load', from).catch(() => {})
  }
  let exported: MethodResultsV2['move.export']
  try {
    begin('unload')
    if (deps.loaded) {
      await source('worktree.unload', from)
      unloaded = true
      deps.progress('unload', 'done')
    } else deps.progress('unload', 'skipped', 'no sessions running')

    begin('export')
    exported = await source('move.export', from, { timeoutMs: STEP_MS })
    const carried = exported.sessions.length
    deps.progress('export', 'done', `${exported.patch ? 'uncommitted work' : 'no uncommitted work'}, ${carried} session histor${carried === 1 ? 'y' : 'ies'}`)

    begin('push')
    await source('worktree.push', { ...from, setUpstream: true }, { timeoutMs: STEP_MS })
    deps.progress('push', 'done')
    begin('receive')
  } catch (err) {
    if (!(err instanceof Cancelled)) deps.progress(step, 'failed', errorText(err))
    await restore()
    return { kind: 'failed', step, error: err instanceof Cancelled ? 'Cancelled' : errorText(err) }
  }

  // From here on there is no cancelling: the target is building it.
  let received: MethodResultsV2['move.receive']
  try {
    const { branch, head, patch, sessions, branchData } = exported
    received = await target('move.receive', { ...to, branch, head, patch, sessions, branchData }, { timeoutMs: STEP_MS })
  } catch (err) {
    deps.progress('receive', 'failed', errorText(err))
    // A refusal undid itself on the target. A lost answer may not have.
    if (errorCode(err) === 'NOT_CONNECTED' || errorCode(err) === 'TIMEOUT') {
      return { kind: 'unknown', error: `${errorText(err)}. The target may have created the worktree: check it before trying again. The source was not changed.` }
    }
    await restore()
    return { kind: 'failed', step: 'receive', error: errorText(err) }
  }
  const notes = [...exported.notCarried.map((line) => `Not carried: ${line}`), ...received.dropped]
  deps.progress('receive', 'done', received.dropped.length > 0 ? `${received.dropped.length} thing(s) not carried over` : undefined)

  deps.progress('finish', 'active')
  try {
    await source('move.finish', { ...from, fingerprint: exported.fingerprint }, { timeoutMs: STEP_MS })
    deps.progress('finish', 'done')
    return { kind: 'moved', worktreeId: received.worktreeId, notes }
  } catch (err) {
    const code = errorCode(err)
    // The source changed (or was loaded) after the copy: the copy on the target is stale, so it goes.
    if (code === 'CONFLICT' || code === 'IN_USE') {
      const undone = await target('worktree.remove', { projectId: to.projectId, worktreeId: received.worktreeId, force: true }).then(() => true, () => false)
      deps.progress('finish', 'failed', errorText(err))
      if (undone) {
        await restore()
        return { kind: 'failed', step: 'finish', error: `${errorText(err)}. The copy on the target was removed again (its branch stays there).` }
      }
      return { kind: 'both', worktreeId: received.worktreeId, error: `${errorText(err)}, and the copy on the target could not be removed: both servers have it now.`, notes }
    }
    deps.progress('finish', 'failed', errorText(err))
    return { kind: 'both', worktreeId: received.worktreeId, error: `The target has the worktree, but the source's copy was not removed (${errorText(err)}). Delete it there once you have checked the target.`, notes }
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
