// A server window's backend: every WindowBackend action as a protocol v2
// request to the window's trek-server. It speaks the legacy store's ids, like
// the components that call it, and maps them to v2 with the projector's
// V2IdMap. Nothing in the store changes ahead of the server (Decision 3 of
// 3c-1): the mirror patch is the answer, and a method that must hand back
// something the patch brings (a new worktree's path, a new session's tab, a
// saved note) waits for it with `whenProjected`, given the rev the response
// reports (`requestWithRev`) when the server sends one.
//
// The methods its callers fire and forget (start, restart, close, load, unload,
// unloadAll) never reject: a refusal goes to `report` (a dialog) and they
// resolve, `start` with null. NOT_CONNECTED is not reported: the window shows
// it is offline, and its commands are disabled.
//
// Pure: the store, the connection, the dialogs and the terminals come in as
// `V2BackendDeps` (built by installV2.ts), so `node --test` covers it.
import type { PromoteOutcome, PromotePlan, PromoteResult } from '../../../shared/promote.ts'
import {
  demotePrompt,
  followPromoteRequests,
  markPromoting,
  promoteErrorText,
  promotePrompt,
  resultNotes,
  PROMOTE_REQUEST_ENDED_IN_TEARDOWN,
  type PromoteFollower
} from './promoteFlow.ts'
import { v2Features, type BackendFeatures } from '../backendFeatures.ts'
import type { PluginPresence } from '../../../shared/plugins/manifest.ts'
import { v2WorktreeOrder, type V2IdMap } from './projector.ts'
import { errorCode, errorText, PROMPT_NOT_CONFIRMED, withPromptText } from './errors.ts'
import { CAPABILITY } from '../../../shared/protocolV2.ts'
import { ClientError } from '../../../shared/client/connection.ts'
import { primaryWorktreeId } from '../../../shared/repositories.ts'
import { hostKey } from '../../../shared/types.ts'
import type { SessionTarget, WindowBackend } from '../backend'
import type { TerminalMeta } from '../store'
import type { EventPayloadsV2, MethodNameV2, MethodParamsV2, MethodResultsV2, TopicRev } from '../../../shared/protocolV2'
import type { RevResult } from '../../../shared/client/connection'
import type { GitWorktreeInfo, ProjectFile, Repository } from '../../../shared/types'

/** `timeoutMs`: for the long ones (an environment's first boot, a compose run): the SDK's default is a minute */
export type V2Request = <M extends MethodNameV2>(method: M, params: MethodParamsV2[M], options?: { timeoutMs?: number }) => Promise<MethodResultsV2[M]>
/** As V2Request, with the rev the response reports (none from a server older than revs). */
export type V2RequestWithRev = <M extends MethodNameV2>(method: M, params: MethodParamsV2[M]) => Promise<RevResult<M>>

/** The part of the store the backend reads: the projected slice. */
export interface V2BackendState {
  project: ProjectFile | null
  terminals: Record<string, TerminalMeta>
  terminalQueues: Record<string, string[]>
  loadedWorktrees: Record<string, true>
  hostWorktrees: Record<string, GitWorktreeInfo[]>
}

export interface ConfirmPrompt {
  title: string
  message: string
  detail?: string
  confirmLabel: string
  /** Lets `closeDialog` close it while it is open (an agent's promote request settled elsewhere) */
  dialogId?: string
}

/**
 * The teardown on the server's machine before a worktree is removed (worktreeTeardown.ts). Used
 * only with the features: `env` for the VM, `stacks` for the dev stack. Each call that reaches the
 * server gets `backend`, the one doing the remove, and sends through it alone.
 */
export interface WorktreeTeardown {
  /** The branch's Colima VM, if the environments poll lists one */
  environment(info: GitWorktreeInfo): { profile: string } | undefined
  /**
   * The confirm, with "Also destroy its dev stack" when its stack has run; the stack's name when
   * that is ticked. `stillWanted` false right before the dialog would show: not shown, not confirmed.
   */
  confirm(info: GitWorktreeInfo, prompt: ConfirmPrompt, backend: WindowBackend, stillWanted?: () => boolean): Promise<{ confirmed: boolean; stackName?: string }>
  /** `stack.sh destroy`; shows its own failure (saying the `action` goes on) and never rejects */
  destroyStack(info: GitWorktreeInfo, stackName: string, backend: WindowBackend, action?: 'delete' | 'promote'): Promise<void>
  /** Deletes the VM; shows its own failure and never rejects */
  destroyEnvironment(info: GitWorktreeInfo, backend: WindowBackend): Promise<void>
  /**
   * A fresh `git status` of the worktree on its server (`worktree.dirty`); the cached flag if it
   * can't be read. Rejects, with the text to show, when the server did not answer in time.
   */
  isDirty(info: GitWorktreeInfo, backend: WindowBackend): Promise<boolean>
}

/** Added to a failed removal's error once its stack or VM is already gone. */
export function tornDownNote(stack: boolean, vm: boolean): string {
  if (stack && vm) return ' Its dev stack and its VM were already removed.'
  if (stack) return ' Its dev stack was already removed.'
  if (vm) return ' Its VM was already removed.'
  return ''
}

export interface V2BackendDeps {
  projectId: string
  request: V2Request
  requestWithRev: V2RequestWithRev
  /** The last welcome's capabilities; undefined before the first one */
  capabilities(): readonly string[] | undefined
  /** The last welcome's plugins; undefined before the first one and from a server older than plugins */
  welcomePlugins(): readonly PluginPresence[] | undefined
  /** The window's entry is the Local server's: with `local` in the welcome, its paths are this machine's (`v2Features`) */
  localEntry: boolean
  /** The server's events of one name on the window's connection (`docker.log`, `env.log`); returns the unsubscribe */
  onEvent<E extends keyof EventPayloadsV2>(event: E, listener: (payload: EventPayloadsV2[E]) => void): () => void
  /** The id map of the projection in the store now */
  ids(): V2IdMap | null
  state(): V2BackendState
  /**
   * Resolves with `check()`'s value once the mirror holds `rev` (the response's;
   * exact), or, without one, its first value other than undefined, re-checked
   * on every store change. Undefined if the projection has not caught up in
   * time, or the window left.
   */
  whenProjected<T>(check: () => T | undefined, rev?: TopicRev): Promise<T | undefined>
  /** A terminal entry's size, for a restart; null without an entry */
  termSize(terminalId: string): { cols: number; rows: number } | null
  focus(terminalId: string): void
  setActiveTerminal(worktreeId: string, terminalId: string): void
  confirm(prompt: ConfirmPrompt): Promise<boolean>
  showError(title: string, message: string): Promise<void>
  /** Asks for a path on the server; null when the user cancels */
  promptRepoPath(): Promise<string | null>
  /** The path the server registered for `server.addRepo`'s repo id, once its `server` topic lists it */
  registeredRepoPath(repoId: string): Promise<string | null>
  /** Why the repository can't be removed now, or null */
  removalBlock(repo: Repository): string | null
  /** The server machine's teardown for a removed worktree; only the `env` and `stacks` features reach it */
  teardown: WorktreeTeardown
  /** Shows a failed request a caller fired and forgot (the setter overrides' `report`) */
  report(title: string, err: unknown): void
  /** Shows a failed edit or prompt send; NOT_CONNECTED says it may not have gone through (`editReporter`) */
  reportEdit(title: string, err: unknown, notConfirmed?: string): void
  /** Whether the window has left this project: nothing it still has in flight shows */
  left(): boolean
  /** Closes the confirmation with this `dialogId` if it is open (answered as cancelled) */
  closeDialog(dialogId: string): void
  /** Calls `listener` each time the window's connection comes up (a reconnect too); returns the unsubscribe */
  onConnected(listener: () => void): () => void
  /** Runs `run` when the window leaves the project (before `left()` turns true) */
  onLeave(run: () => void): void
  /** A failure only a developer sees (the console) */
  log(message: string, err?: unknown): void
}

/**
 * A new session's terminal size, before any pane has measured it: the pane's
 * first fit (and `sendV2Size` when it is shown) resizes it.
 */
export const V2_START_SIZE = { cols: 120, rows: 32 }

/**
 * git's refusal to remove a worktree with uncommitted work, inside the server's
 * GIT_ERROR, from a server that sends no `details.reason`. English text: a git
 * in another locale words it differently.
 */
const UNCOMMITTED = /modified or untracked/i

/** The server refused a removal because the worktree has changes: `details.reason`, or git's English text. */
function refusedAsDirty(err: unknown): boolean {
  if (errorCode(err) !== 'GIT_ERROR') return false
  const reason = (err as { details?: { reason?: unknown } }).details?.reason
  return reason === 'dirty' || UNCOMMITTED.test(errorText(err))
}

class TargetError extends Error {
  readonly code = 'NOT_FOUND'
}

const REMOVE_FAILED = 'Could not delete worktree'

/** The machine methods that can run for minutes (a VM's first boot, an image build, a stack's database restore). */
const LONG_MS = 30 * 60_000
/** colima stop and delete, a stack's down and destroy (each Ctrl-C's a running up and waits up to a minute) */
const SLOW_MS = 10 * 60_000
const PROMOTE_FAILED = 'Could not promote worktree'
const DEMOTE_FAILED = 'Could not move the branch to a worktree'
/** docker start, stop and restart (the server gives docker two minutes) */
const CONTAINER_MS = 3 * 60_000

const NOT_REGISTERED = "Registered on the server but it isn't visible here yet — try again."

export function createV2Backend(deps: V2BackendDeps): WindowBackend {
  const { projectId, request, requestWithRev } = deps
  const ids = (): V2IdMap => deps.ids() ?? { worktrees: {}, worktreeByPath: {}, sessions: {}, legacyByWorktree: {} }

  /** The v2 worktree of a legacy instance id (a primary id for a main checkout). */
  const worktreeOf = (legacyId: string): string => {
    const ref = ids().worktrees[legacyId]
    if (!ref) throw new TargetError(`No worktree ${legacyId} in this project`)
    return ref.worktreeId
  }
  const legacyIdAt = (path: string): string | undefined => ids().worktreeByPath[path]
  const worktreeAt = (path: string): string => {
    const legacyId = legacyIdAt(path)
    if (legacyId === undefined) throw new TargetError(`No worktree at ${path} in this project`)
    return worktreeOf(legacyId)
  }
  const session = (terminalId: string): { projectId: string; sessionId: string } => ({ projectId, sessionId: terminalId })

  const report = (title: string, err: unknown): void => {
    if (errorCode(err) !== 'NOT_CONNECTED') deps.report(title, err)
  }
  /** Runs a fire-and-forget method: a failure is reported, and it resolves with `fallback`. */
  const reported = async <T>(title: string, fallback: T, run: () => Promise<T>): Promise<T> => {
    try {
      return await run()
    } catch (err) {
      report(title, err)
      return fallback
    }
  }

  /** Waits for the new session's tab, then makes it the worktree's active one, as legacy does. */
  const showStarted = async ({ result, rev }: RevResult<'session.start'>): Promise<string> => {
    const { sessionId } = result
    const meta = await deps.whenProjected(() => deps.state().terminals[sessionId], rev)
    if (meta) deps.setActiveTerminal(meta.worktreeId, sessionId)
    return sessionId
  }

  let globalStart: Promise<string | null> | null = null
  const startGlobal = (): Promise<string | null> => {
    globalStart ??= requestWithRev('session.start', { projectId, worktreeId: null, ...V2_START_SIZE })
      .then(showStarted)
      .finally(() => {
        globalStart = null
      })
    return globalStart
  }

  const repoOf = (repoId: string): Repository | undefined =>
    deps.state().project?.repositories.find((r) => r.id === repoId)

  /** A legacy instance's path in the projected project (a primary id is its repository's main checkout). */
  const instancePath = (legacyId: string): string | undefined => {
    for (const repo of deps.state().project?.repositories ?? []) {
      if (primaryWorktreeId(repo.id) === legacyId) return repo.path
      const found = repo.worktrees.find((w) => w.id === legacyId)
      if (found) return found.path
    }
    return undefined
  }

  const removeWorktree = async (worktreeId: string, force: boolean): Promise<void> => {
    await request('worktree.remove', { projectId, worktreeId, force })
  }

  const branchRef = (repoId: string, branch: string) => ({ projectId, repoId, branch })

  let promoteFollower: PromoteFollower | null = null
  let features: { caps: readonly string[] | undefined; value: BackendFeatures } | null = null
  const can = (capability: string): boolean => deps.capabilities()?.includes(capability) ?? false
  const currentFeatures = (): BackendFeatures => {
    const caps = deps.capabilities()
    if (!features || features.caps !== caps) features = { caps, value: v2Features(caps, { localEntry: deps.localEntry }) }
    return features.value
  }

  const backend: WindowBackend = {
    kind: 'v2',
    /** Read at the time: the capabilities arrive with the welcome (useFeatures re-reads them). */
    get features(): BackendFeatures {
      return currentFeatures()
    },
    sessions: {
      start: (target: SessionTarget, sessionType, llm) =>
        reported('Could not start the session', null, async () => {
          const legacyId = 'worktreeId' in target ? target.worktreeId : legacyIdAt(target.path)
          const ref = legacyId === undefined ? undefined : ids().worktrees[legacyId]
          if (!ref) return null
          const started = await requestWithRev('session.start', {
            projectId,
            worktreeId: ref.worktreeId,
            ...(sessionType ? { sessionTypeId: sessionType.id } : {}),
            ...(llm ? { llm } : {}),
            ...V2_START_SIZE
          })
          return showStarted(started)
        }),
      startGlobal,
      // Only when there are none, and never twice: the panel asks again on every
      // render with no tabs, and the new session's patch is still on its way.
      openGlobal: async () => {
        if (globalStart) {
          await globalStart
          return
        }
        if ((deps.state().project?.globalSessions?.length ?? 0) > 0) return
        await startGlobal()
      },
      restart: (terminalId) =>
        reported('Could not restart the session', undefined, async () => {
          const size = deps.termSize(terminalId) ?? V2_START_SIZE
          await request('session.restart', { ...session(terminalId), cols: size.cols, rows: size.rows })
          deps.focus(terminalId)
        }),
      close: (terminalId) =>
        reported('Could not close the session', undefined, async () => {
          await request('session.close', session(terminalId))
        }),
      // `expected`, the title the edit started from, makes it compare-and-set: a rename made elsewhere meanwhile wins.
      rename: async (terminalId, title, expected) => {
        const trimmed = title.trim()
        if (!trimmed || trimmed === deps.state().terminals[terminalId]?.title) return
        try {
          await request('session.rename', { ...session(terminalId), title: trimmed, ...(expected !== undefined ? { expected } : {}) })
        } catch (err) {
          if (errorCode(err) !== 'CONFLICT') throw err
          throw new ClientError('CONFLICT', `The session was renamed elsewhere meanwhile, so “${trimmed}” was not saved.`)
        }
      },
      sendPrompt: async (terminalId, text, focus = true) => {
        await request('session.sendPrompt', { ...session(terminalId), text })
        if (focus) deps.focus(terminalId)
      },
      enqueue: async (terminalId, text) => {
        await request('session.enqueue', { ...session(terminalId), text })
      },
      setQueue: async (terminalId, queue) => {
        await request('session.setQueue', { ...session(terminalId), queue })
      },
      // Compare-and-set where the server has it; an older one gets the whole list without the item.
      dequeue: async (terminalId, index, expected) => {
        if (can(CAPABILITY.dequeue)) {
          await request('session.dequeue', { ...session(terminalId), index, expected })
          return
        }
        const queue = deps.state().terminalQueues[terminalId]
        if (!queue || queue[index] !== expected) return
        await request('session.setQueue', { ...session(terminalId), queue: queue.filter((_, i) => i !== index) })
      },
      markComplete: async (terminalId, complete) => {
        await request('session.markComplete', { ...session(terminalId), complete })
      },
      seen: async (terminalId) => {
        await request('session.seen', session(terminalId))
      },
      // A server without `decisions` has none to dismiss.
      dismissDecision: async (terminalId) => {
        if (can(CAPABILITY.decisions)) await request('session.dismissDecision', session(terminalId))
      }
    },
    worktrees: {
      load: (legacyId) =>
        reported('Could not load the worktree', undefined, async () => {
          await request('worktree.load', { projectId, worktreeId: worktreeOf(legacyId) })
        }),
      unload: (legacyId) =>
        reported('Could not unload the worktree', undefined, async () => {
          await request('worktree.unload', { projectId, worktreeId: worktreeOf(legacyId) })
        }),
      // Each one on its own: one refusal doesn't keep the rest loaded. The first is reported.
      unloadAll: async () => {
        const map = ids().worktrees
        const targets = Object.keys(deps.state().loadedWorktrees).flatMap((legacyId) =>
          map[legacyId] ? [map[legacyId].worktreeId] : []
        )
        const results = await Promise.allSettled(targets.map((worktreeId) => request('worktree.unload', { projectId, worktreeId })))
        const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')
        if (failed) report('Could not unload every worktree', failed.reason)
      },
      // The server links the dirs and tags the branch itself.
      create: async ({ repoId, branch, createBranch, fromPr }) => {
        const { result, rev } = await requestWithRev('worktree.create', {
          projectId,
          repoId,
          branch,
          createBranch,
          ...(fromPr !== undefined ? { fromPr } : {})
        })
        const { worktreeId } = result
        // The response can come before the patch that lists the worktree.
        const path = await deps.whenProjected(() => {
          const legacyId = ids().legacyByWorktree[worktreeId]
          return legacyId === undefined ? undefined : instancePath(legacyId)
        }, rev)
        if (path === undefined) throw new Error(`The server created the worktree, but it has not shown up here yet.`)
        return { path, worktreeId }
      },
      // The server's rules: a loaded worktree is IN_USE, so it is unloaded
      // first, and loaded again when the removal doesn't go through. With the
      // `stacks` and `env` features it also tears down the worktree's dev stack
      // (if ticked) and its VM on the server's machine, after the unload and
      // before git's removal (4c's order).
      remove: async (info, instance) => {
        const legacyId = instance?.id ?? legacyIdAt(info.path)
        const ref = legacyId === undefined ? undefined : ids().worktrees[legacyId]
        if (!ref || legacyId === undefined) {
          await deps.showError(REMOVE_FAILED, 'This worktree is no longer in the project.')
          return
        }
        const { worktreeId } = ref
        // The server's status poll; a stale "clean" is caught by git below, unless the teardown
        // would destroy something first: that is checked afresh below, after the confirm.
        let dirty = info.dirty ?? false
        const loaded = deps.state().loadedWorktrees[legacyId] === true
        const name = info.branch ?? info.path
        const machine = currentFeatures()
        const env = machine.env ? deps.teardown.environment(info) : undefined
        const prompt: ConfirmPrompt = {
          title: 'Delete Worktree',
          message: `Delete worktree “${name}”?`,
          detail:
            `This runs "git worktree remove" on ${info.path} and deletes the directory. ` +
            `The branch itself is kept. ` +
            (loaded ? 'Its running sessions will be stopped. ' : '') +
            (dirty
              ? 'This worktree has uncommitted changes — they will be permanently deleted.'
              : 'Uncommitted changes will block the deletion.') +
            (env ? ` Its Docker environment (Colima VM “${env.profile}”) and all its data will also be deleted.` : ''),
          confirmLabel: dirty ? 'Delete Worktree & Changes' : 'Delete Worktree'
        }
        const { confirmed, stackName } = machine.stacks
          ? await deps.teardown.confirm(info, prompt, backend)
          : { confirmed: await deps.confirm(prompt), stackName: undefined }
        if (!confirmed) return
        const askDiscard = (): Promise<boolean> =>
          deps.confirm({
            title: 'Delete Uncommitted Changes',
            message: `“${name}” has uncommitted changes.`,
            detail: 'Deleting this worktree will permanently discard them. This cannot be undone.',
            confirmLabel: 'Delete Changes & Worktree'
          })
        // The stack and the VM can't come back: git's refusal after them would be too late to ask
        // (legacy runs worktreeIsDirty first). Asked before anything is unloaded or destroyed.
        if ((stackName || env) && !dirty) {
          let fresh: boolean
          try {
            fresh = await deps.teardown.isDirty(info, backend)
          } catch (err) {
            // No answer in time: nothing is unloaded or destroyed on a guess.
            await deps.showError(REMOVE_FAILED, errorText(err))
            return
          }
          if (fresh) {
            if (!(await askDiscard())) return
            dirty = true
          }
        }
        let wasLoaded = false
        let tornDown = { stack: false, vm: false }
        // Best effort: the removal's own error is the one to show.
        const reload = async (): Promise<void> => {
          if (wasLoaded) await request('worktree.load', { projectId, worktreeId }).catch(() => {})
        }
        const fail = async (err: unknown): Promise<void> => {
          await reload()
          await deps.showError(REMOVE_FAILED, errorText(err) + tornDownNote(tornDown.stack, tornDown.vm))
        }
        try {
          if (loaded) {
            await request('worktree.unload', { projectId, worktreeId })
            wasLoaded = true
          }
          // Stack and environment first: they need the worktree's files, and their
          // containers hold bind-mount handles into it. Neither rejects.
          if (stackName) await deps.teardown.destroyStack(info, stackName, backend)
          if (env) await deps.teardown.destroyEnvironment(info, backend)
          tornDown = { stack: !!stackName, vm: !!env }
          await removeWorktree(worktreeId, dirty)
          return
        } catch (err) {
          // Changes can appear between the poll and the removal.
          if (dirty || !refusedAsDirty(err)) {
            await fail(err)
            return
          }
        }
        if (!(await askDiscard())) {
          await reload()
          return
        }
        try {
          await removeWorktree(worktreeId, true)
        } catch (forceErr) {
          await fail(forceErr)
        }
      },
      // 5e. The plan first (the same checks as the real one, so nothing is torn down for a promote
      // the server would refuse), then the confirmation, the claim of an agent's request (before
      // anything is torn down), the stack and the VM (they need the worktree's files), then the
      // promote itself in one request, which settles an agent's request on the server.
      promote: async (info, instance, asked) => {
        const legacyId = instance?.id ?? legacyIdAt(info.path)
        const ref = legacyId === undefined ? undefined : ids().worktrees[legacyId]
        const failed = async (err: unknown, note = ''): Promise<PromoteOutcome> => {
          const error = promoteErrorText(err) + note
          await deps.showError(PROMOTE_FAILED, error)
          return { outcome: 'failed', error }
        }
        // An agent's request for a worktree this window doesn't list: it says so (silently); another window answers it.
        if (!ref) {
          if (!asked) return failed(new Error('This worktree is no longer in the project.'))
          await asked.answer({ outcome: 'unknown-worktree' })
          return { outcome: 'failed', error: 'not listed in this window' }
        }
        const { worktreeId } = ref
        let plan: PromotePlan
        try {
          plan = (await request('worktree.promote', { projectId, worktreeId, dryRun: true })) as PromotePlan
        } catch (err) {
          if (!asked) return failed(err)
          // The server refuses it: the first window to see that answers for all, without a dialog.
          const error = errorText(err)
          if (errorCode(err) !== 'NOT_CONNECTED' && (await asked.claim({ silent: true }))) await asked.answer({ outcome: 'failed', error })
          return { outcome: 'failed', error }
        }
        if (asked && !asked.stillAsked()) return { outcome: 'declined' }
        const machine = currentFeatures()
        const env = machine.env ? deps.teardown.environment(info) : undefined
        const prompt = promotePrompt(plan, { vm: env?.profile, asked })
        // Checked again right before the dialog shows (the stack's status is read first).
        const stillWanted = asked ? (): boolean => asked.stillAsked() : undefined
        const { confirmed, stackName } = machine.stacks
          ? await deps.teardown.confirm(info, prompt, backend, stillWanted)
          : { confirmed: stillWanted && !stillWanted() ? false : await deps.confirm(prompt), stackName: undefined }
        if (!confirmed) {
          // Closed because the request was settled elsewhere: nothing to answer.
          if (asked?.stillAsked()) await asked.answer({ outcome: 'declined' })
          return { outcome: 'declined' }
        }
        // The claim first: the first window to confirm runs it; the others' dialogs close.
        if (asked && !(await asked.claim())) return { outcome: 'declined' }
        const release = markPromoting(info.path)
        // The claim is refreshed while the teardown runs (and taken back after a reconnect).
        const stopHolding = asked?.holdClaim() ?? ((): void => {})
        try {
          try {
            if (stackName) await deps.teardown.destroyStack(info, stackName, backend, 'promote')
            if (env) await deps.teardown.destroyEnvironment(info, backend)
          } catch (err) {
            const error = `The teardown before the promote failed: ${errorText(err)}. Nothing was promoted.${tornDownNote(!!stackName, false)}`
            if (asked) await asked.answer({ outcome: 'failed', error })
            await deps.showError(PROMOTE_FAILED, error)
            return { outcome: 'failed', error }
          }
          try {
            const claimToken = asked?.claimToken()
            const params = { projectId, worktreeId, ...(asked ? { requestId: asked.requestId, ...(claimToken ? { claimToken } : {}) } : {}) }
            const result = (await request('worktree.promote', params, { timeoutMs: SLOW_MS })) as PromoteResult
            const notes = resultNotes(result)
            if (notes) await deps.showError('Promoted, with notes', notes)
            return { outcome: 'promoted', worktreeId: result.worktreeId }
          } catch (err) {
            if (asked && (stackName || env) && errorCode(err) === 'NOT_FOUND' && /promote request/i.test(errorText(err))) {
              const error = PROMOTE_REQUEST_ENDED_IN_TEARDOWN
              await deps.showError(PROMOTE_FAILED, error)
              return { outcome: 'failed', error }
            }
            return failed(err, tornDownNote(!!stackName, !!env))
          }
        } finally {
          stopHolding()
          release()
        }
      },
      demote: async (info) => {
        const repoId = info.repoId
        if (!repoId) {
          await deps.showError(DEMOTE_FAILED, 'This checkout is no longer in the project.')
          return
        }
        let plan: PromotePlan
        try {
          plan = (await request('worktree.demote', { projectId, repoId, dryRun: true })) as PromotePlan
        } catch (err) {
          await deps.showError(DEMOTE_FAILED, promoteErrorText(err))
          return
        }
        if (!(await deps.confirm(demotePrompt(plan)))) return
        try {
          const result = (await request('worktree.demote', { projectId, repoId }, { timeoutMs: SLOW_MS })) as PromoteResult
          const notes = resultNotes(result)
          if (notes) await deps.showError('Moved, with notes', notes)
        } catch (err) {
          await deps.showError(DEMOTE_FAILED, promoteErrorText(err))
        }
      },
      // One follower per backend: it lives until the window leaves the project (a reconnect, or a
      // new welcome, keeps it and its open dialog), and says `promote.listen` again on every connect.
      followPromoteRequests: () => {
        if (promoteFollower || deps.left()) return
        const listen = (): void => {
          if (deps.left() || !currentFeatures().promote) return
          request('promote.listen', { projectId }).catch((err: unknown) => {
            if (errorCode(err) !== 'NOT_CONNECTED') deps.log('promote.listen failed: agents cannot ask this window to promote', err)
          })
        }
        const follower: PromoteFollower = followPromoteRequests({
          onRequest: (listener) =>
            deps.onEvent('promote.request', (event) => {
              if (event.projectId === projectId) listener(event)
            }),
          onSettled: (listener) =>
            deps.onEvent('promote.settled', (event) => {
              if (event.projectId === projectId) listener(event)
            }),
          run: async (event, asked) => {
            const legacyId = ids().legacyByWorktree[event.worktreeId]
            const path = legacyId === undefined ? undefined : instancePath(legacyId)
            const info = path === undefined ? undefined : Object.values(deps.state().hostWorktrees).flat().find((w) => w.path === path)
            // A window that can't find it says so, silently: another one answers (or, when none
            // lists it, the server ends the request).
            if (!info || legacyId === undefined) {
              await asked.answer({ outcome: 'unknown-worktree' })
              return
            }
            const instance = deps.state().project?.repositories.flatMap((r) => r.worktrees).find((w) => w.id === legacyId)
            await backend.worktrees.promote(info, instance, asked)
          },
          claim: async (requestId, claimToken) => {
            const result = await request('promote.claim', { projectId, requestId, ...(claimToken ? { claimToken } : {}) })
            return { accepted: result.accepted, ...(result.accepted && result.claimToken ? { claimToken: result.claimToken } : {}) }
          },
          answer: async (requestId, outcome, claimToken) =>
            (await request('promote.answer', { projectId, requestId, ...outcome, ...(claimToken ? { claimToken } : {}) })).accepted,
          onConnected: deps.onConnected,
          closeDialog: deps.closeDialog,
          showError: deps.showError,
          log: deps.log,
          left: deps.left
        })
        const offConnected = deps.onConnected(listen)
        listen()
        promoteFollower = follower
        deps.onLeave(() => {
          offConnected()
          follower.stop()
          request('promote.listen', { projectId, listen: false }).catch(() => {})
        })
      },
      moveRef: (path) => {
        const legacyId = legacyIdAt(path)
        const ref = legacyId === undefined ? undefined : ids().worktrees[legacyId]
        return ref ? { projectId, worktreeId: ref.worktreeId } : null
      },
      // The one settings write a server window makes (settings are read-only in v2).
      // No keys clears the order; keys none of which map (a stale drag) send nothing.
      setOrder: async (keys) => {
        const order = keys.length === 0 ? null : v2WorktreeOrder(keys, ids())
        if (order !== null && order.length === 0) return
        await request('project.updateSettings', { projectId, settings: { worktreeOrder: order } })
      }
    },
    git: {
      // The mirror already has them: no request.
      listWorktrees: async (repoId) => deps.state().hostWorktrees[`${repoId} ${hostKey()}`] ?? [],
      listBranches: (repoId) => request('repo.listBranches', { projectId, repoId }),
      // A source only when one is asked for: an older server's params are the same as before.
      changes: async (loc, source) => request('worktree.changes', { projectId, worktreeId: worktreeAt(loc.path), ...(source ? { source } : {}) }),
      diff: async (loc, source) => request('worktree.diff', { projectId, worktreeId: worktreeAt(loc.path), ...(source ? { source } : {}) }),
      commits: async (loc) => request('worktree.commits', { projectId, worktreeId: worktreeAt(loc.path) }),
      pull: async (loc) => {
        await request('worktree.pull', { projectId, worktreeId: worktreeAt(loc.path) })
      },
      // Always with -u.
      push: async (loc) => {
        await request('worktree.push', { projectId, worktreeId: worktreeAt(loc.path), setUpstream: true })
      },
      dirty: async (loc) => request('worktree.dirty', { projectId, worktreeId: worktreeAt(loc.path) })
    },
    // Every path the server needs it finds itself, from the ids: a worktree by the store's path,
    // a repository by its id. Nothing else of this machine's goes over.
    docker: {
      list: () => request('docker.list', {}),
      container: async (action, id) => {
        await request('docker.container', { action, id }, { timeoutMs: CONTAINER_MS })
      },
      compose: (repoId, action) => request('docker.compose', { projectId, repoId, action }, { timeoutMs: LONG_MS }),
      onLog: (listener) => deps.onEvent('docker.log', listener)
    },
    env: {
      check: () => request('env.check', {}),
      list: (repoId) => request('env.list', { projectId, repoId }),
      up: async (loc, settings, envVars) =>
        request('env.up', { projectId, worktreeId: worktreeAt(loc.path), settings, ...(envVars ? { envVars } : {}) }, { timeoutMs: LONG_MS }),
      stop: (profile) => request('env.stop', { profile }, { timeoutMs: SLOW_MS }),
      destroy: (profile) => request('env.destroy', { profile }, { timeoutMs: SLOW_MS }),
      ps: async (loc, composeFile) => request('env.ps', { projectId, worktreeId: worktreeAt(loc.path), ...(composeFile ? { composeFile } : {}) }),
      composeFiles: async (loc) => request('env.composeFiles', { projectId, worktreeId: worktreeAt(loc.path) }),
      logs: async (loc, composeFile, service, tail) =>
        request('env.logs', { projectId, worktreeId: worktreeAt(loc.path), ...(composeFile ? { composeFile } : {}), service, tail }),
      onLog: (listener) => deps.onEvent('env.log', listener)
    },
    stacks: {
      status: async (loc) => request('stack.status', { projectId, worktreeId: worktreeAt(loc.path) }),
      up: async (loc, starter) => {
        await request('stack.up', { projectId, worktreeId: worktreeAt(loc.path), starter })
      },
      down: async (loc) => request('stack.down', { projectId, worktreeId: worktreeAt(loc.path) }, { timeoutMs: SLOW_MS }),
      destroy: async (loc) => request('stack.destroy', { projectId, worktreeId: worktreeAt(loc.path) }, { timeoutMs: SLOW_MS }),
      log: async (loc, fileId, offset) => request('stack.log', { projectId, worktreeId: worktreeAt(loc.path), fileId, offset })
    },
    skills: {
      list: async (loc) => request('skills.list', { projectId, worktreeId: worktreeAt(loc.path) })
    },
    // The draft is the worktree's `review` in the project topic: the patch is the answer.
    review: {
      add: async (path, comment) => (await request('review.add', { projectId, worktreeId: worktreeAt(path), ...comment })).commentId,
      edit: async (path, commentId, body, expected) => {
        await request('review.edit', { projectId, worktreeId: worktreeAt(path), commentId, body, expected })
      },
      remove: async (path, commentId) => {
        await request('review.remove', { projectId, worktreeId: worktreeAt(path), commentId })
      },
      clear: async (path, revision) => {
        await request('review.clear', { projectId, worktreeId: worktreeAt(path), revision })
      },
      send: async (path, terminalId, revision) => {
        await request('review.send', { projectId, worktreeId: worktreeAt(path), sessionId: terminalId, revision })
      }
    },
    branch: {
      setTag: async (repoId, branch, tagId) => {
        await request('branch.setTag', { ...branchRef(repoId, branch), tag: tagId })
      },
      // The whole list, from the slice: no compare-and-set (accepted, Notes for 3c-2 #4).
      setCustomTag: async (repoId, branch, tagId, enabled) => {
        const current = repoOf(repoId)?.branchCustomTags?.[branch] ?? []
        const next = enabled ? [...current.filter((t) => t !== tagId), tagId] : current.filter((t) => t !== tagId)
        await request('branch.setCustomTags', { ...branchRef(repoId, branch), customTags: next.length > 0 ? next : null })
      },
      // Resolves once the mirror holds the save (its rev), so the notes draft settles on exactly that state.
      setNote: async (repoId, branch, text, expected) => {
        const { rev } = await requestWithRev('branch.setNote', {
          ...branchRef(repoId, branch),
          note: text || null,
          ...(expected !== undefined ? { expected: expected || null } : {})
        })
        if (rev) await deps.whenProjected(() => true, rev)
      },
      setTicket: async (repoId, branch, ticketId) => {
        await request('branch.setTicket', { ...branchRef(repoId, branch), ticket: ticketId })
      },
      setPullRequest: async (repoId, branch, url) => {
        await request('branch.setPr', { ...branchRef(repoId, branch), pr: url })
      },
      setPrWatch: async (repoId, branch, watch) => {
        await request('branch.setPrWatch', { ...branchRef(repoId, branch), watch })
      },
      dismissPrNotice: async (path) => {
        await request('prWatch.dismiss', { projectId, worktreeId: worktreeAt(path) })
      },
      setEnvVars: async (repoId, branch, text) => {
        await request('branch.setEnv', { ...branchRef(repoId, branch), env: text || null })
      }
    },
    repos: {
      // repo.add only takes a path the server has registered, so register it first.
      add: async () => {
        const path = await deps.promptRepoPath()
        if (!path) return
        try {
          const { repoId } = await request('server.addRepo', { path })
          const registered = await deps.registeredRepoPath(repoId)
          if (registered === null) {
            await deps.showError('Could not add the repository', NOT_REGISTERED)
            return
          }
          await request('repo.add', { projectId, path: registered })
        } catch (err) {
          await deps.showError('Could not add the repository', errorText(err))
        }
      },
      remove: async (repo) => {
        const block = deps.removalBlock(repo)
        if (block) {
          await deps.showError(`Can't remove ${repo.name}`, block)
          return
        }
        const confirmed = await deps.confirm({
          title: 'Remove Repository',
          message: `Remove “${repo.name}” from this project?`,
          detail:
            'Its tags, notes, ticket links, pull request links and saved session lists are ' +
            'deleted from the project on the server. ' +
            `Nothing is changed on disk at ${repo.path}.`,
          confirmLabel: 'Remove from Project'
        })
        if (!confirmed) return
        try {
          await request('repo.remove', { projectId, repoId: repo.id })
        } catch (err) {
          await deps.showError(`Can't remove ${repo.name}`, errorText(err))
        }
      }
    },
    // deps.showError and deps.report already show nothing once the window left.
    errors: {
      show: (title, message) => void deps.showError(title, message),
      report,
      promptFailed: (title, err, text) => {
        if (errorCode(err) === 'NOT_CONNECTED') deps.reportEdit(title, err, withPromptText(PROMPT_NOT_CONFIRMED, text))
        else void deps.showError(title, withPromptText(errorText(err), text))
      },
      inline: (err) => (deps.left() || errorCode(err) === 'NOT_CONNECTED' ? null : errorText(err))
    },
    // Each plugin types its own methods and events; here they are the wire's names, untyped.
    plugins: {
      projectId,
      welcome: () => {
        const capabilities = deps.capabilities()
        if (!capabilities) return undefined
        const plugins = deps.welcomePlugins()
        return plugins ? { plugins, capabilities } : { capabilities }
      },
      request: (method, params) => (deps.request as unknown as (m: string, p: Record<string, unknown>) => Promise<unknown>)(method, params),
      onEvent: (event, listener) => (deps.onEvent as unknown as (e: string, l: (payload: unknown) => void) => () => void)(event, listener),
      onConnected: (listener) => deps.onConnected(listener)
    }
  }
  return backend
}
