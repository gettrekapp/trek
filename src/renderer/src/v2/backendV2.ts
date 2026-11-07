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
import { v2Features, type BackendFeatures } from '../backendFeatures.ts'
import { v2WorktreeOrder, type V2IdMap } from './projector.ts'
import { errorCode, errorText, PROMPT_NOT_CONFIRMED } from './errors.ts'
import { CAPABILITY } from '../../../shared/protocolV2.ts'
import { ClientError } from '../../../shared/client/connection.ts'
import { primaryWorktreeId } from '../../../shared/repositories.ts'
import { hostKey } from '../../../shared/types.ts'
import type { SessionTarget, WindowBackend } from '../backend'
import type { TerminalMeta } from '../store'
import type { MethodNameV2, MethodParamsV2, MethodResultsV2, TopicRev } from '../../../shared/protocolV2'
import type { RevResult } from '../../../shared/client/connection'
import type { GitWorktreeInfo, ProjectFile, Repository } from '../../../shared/types'

export type V2Request = <M extends MethodNameV2>(method: M, params: MethodParamsV2[M]) => Promise<MethodResultsV2[M]>
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
}

export interface V2BackendDeps {
  projectId: string
  request: V2Request
  requestWithRev: V2RequestWithRev
  /** The last welcome's capabilities; undefined before the first one */
  capabilities(): readonly string[] | undefined
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
  /** Shows a failed request a caller fired and forgot (the setter overrides' `report`) */
  report(title: string, err: unknown): void
  /** Shows a failed edit or prompt send; NOT_CONNECTED says it may not have gone through (`editReporter`) */
  reportEdit(title: string, err: unknown, notConfirmed?: string): void
  /** Whether the window has left this project: nothing it still has in flight shows */
  left(): boolean
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

  let features: { caps: readonly string[] | undefined; value: BackendFeatures } | null = null
  const can = (capability: string): boolean => deps.capabilities()?.includes(capability) ?? false

  return {
    kind: 'v2',
    /** Read at the time: the capabilities arrive with the welcome (useFeatures re-reads them). */
    get features(): BackendFeatures {
      const caps = deps.capabilities()
      if (!features || features.caps !== caps) features = { caps, value: v2Features(caps) }
      return features.value
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
      // Legacy's dialogs and order (worktreeActions.deleteWorktree), with the
      // server's rules: a loaded worktree is IN_USE, so it is unloaded first,
      // and loaded again when the removal doesn't go through.
      remove: async (info, instance) => {
        const legacyId = instance?.id ?? legacyIdAt(info.path)
        const ref = legacyId === undefined ? undefined : ids().worktrees[legacyId]
        if (!ref || legacyId === undefined) {
          await deps.showError(REMOVE_FAILED, 'This worktree is no longer in the project.')
          return
        }
        const { worktreeId } = ref
        // The server's status poll; a stale "clean" is caught by git below.
        const dirty = info.dirty ?? false
        const loaded = deps.state().loadedWorktrees[legacyId] === true
        const name = info.branch ?? info.path
        const confirmed = await deps.confirm({
          title: 'Delete Worktree',
          message: `Delete worktree “${name}”?`,
          detail:
            `This runs "git worktree remove" on ${info.path} and deletes the directory. ` +
            `The branch itself is kept. ` +
            (loaded ? 'Its running sessions will be stopped. ' : '') +
            (dirty
              ? 'This worktree has uncommitted changes — they will be permanently deleted.'
              : 'Uncommitted changes will block the deletion.'),
          confirmLabel: dirty ? 'Delete Worktree & Changes' : 'Delete Worktree'
        })
        if (!confirmed) return
        let wasLoaded = false
        // Best effort: the removal's own error is the one to show.
        const reload = async (): Promise<void> => {
          if (wasLoaded) await request('worktree.load', { projectId, worktreeId }).catch(() => {})
        }
        const fail = async (err: unknown): Promise<void> => {
          await reload()
          await deps.showError(REMOVE_FAILED, errorText(err))
        }
        try {
          if (loaded) {
            await request('worktree.unload', { projectId, worktreeId })
            wasLoaded = true
          }
          await removeWorktree(worktreeId, dirty)
          return
        } catch (err) {
          // Changes can appear between the poll and the removal.
          if (dirty || !refusedAsDirty(err)) {
            await fail(err)
            return
          }
        }
        const discard = await deps.confirm({
          title: 'Delete Uncommitted Changes',
          message: `“${name}” has uncommitted changes.`,
          detail: 'Deleting this worktree will permanently discard them. This cannot be undone.',
          confirmLabel: 'Delete Changes & Worktree'
        })
        if (!discard) {
          await reload()
          return
        }
        try {
          await removeWorktree(worktreeId, true)
        } catch (forceErr) {
          await fail(forceErr)
        }
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
      changes: async (loc) => request('worktree.changes', { projectId, worktreeId: worktreeAt(loc.path) }),
      diff: async (loc) => request('worktree.diff', { projectId, worktreeId: worktreeAt(loc.path) }),
      pull: async (loc) => {
        await request('worktree.pull', { projectId, worktreeId: worktreeAt(loc.path) })
      },
      // Legacy pushes with -u.
      push: async (loc) => {
        await request('worktree.push', { projectId, worktreeId: worktreeAt(loc.path), setUpstream: true })
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
      promptFailed: (title, err) => deps.reportEdit(title, err, PROMPT_NOT_CONFIRMED),
      inline: (err) => (deps.left() || errorCode(err) === 'NOT_CONNECTED' ? null : errorText(err))
    }
  }
}
