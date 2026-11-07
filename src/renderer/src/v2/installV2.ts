// Puts a window into server-project mode and takes it out again. windowKind.ts
// calls it whenever `serverWindow` changes, inside the same `set`, so the
// backend, the store-setter overrides and the projected slice always change
// together: a window that goes back to the picker never keeps v2 overrides on
// a legacy backend, nor a projected project the legacy Workspace would render.
import { useAppStore } from '../store'
import { disposeV2Terminals, focusTerminal, terminalSize } from '../terminals'
import { removalBlock } from '../repositoryActions'
import { createV2Backend, type V2Request, type V2RequestWithRev } from './backendV2'
import { OVERRIDDEN_SETTERS, v2SetterOverrides, type SetterOverrides } from './setterOverrides'
import { clearV2Projection, v2Ids } from './applyProjection'
import { registeredServerEntry } from './serverClients'
import { cancelRepoPath, requestRepoPath } from './repoPathPrompt'
import { editReporter, errorCode, errorText } from './errors'
import { ClientError, type TopicMirror } from '../../../shared/client/index.ts'
import type { TopicRev } from '../../../shared/protocolV2'
import { OFF_VIEW } from '../../../shared/bot'
import type { WindowBackend } from '../backend'
import type { AppState } from '../store'

/** How long an action waits for its result to show up in the mirror, when the response carries no rev. */
const PROJECTION_WAIT_MS = 10_000
/**
 * How long it waits for the response's rev. The patch is normally applied
 * before the response arrives; the bound covers a reconnect, whose
 * resubscribe brings it (or the newest state, after a server restart).
 */
const REV_WAIT_MS = 30_000

export interface V2Window {
  entryId: string
  projectId: string
  backend: WindowBackend
  /** Back to no project: terminals, ids, the projected slice and the setter overrides go. */
  leave(): void
}

/** The projected slice and the window's server-mode state, emptied. */
const EMPTY: Partial<AppState> = {
  project: null,
  filePath: null,
  dirty: false,
  activeWorktreeId: null,
  selected: null,
  terminals: {},
  terminalOrder: {},
  activeTerminal: {},
  loadedWorktrees: {},
  hostWorktrees: {},
  terminalQueues: {},
  decisions: {},
  serverOffline: false,
  serverLink: null
}

/**
 * View state a window keeps from what it showed before (a file window's open
 * Global panel or bot tab, its bot, Colima environments, Linear chips, voice
 * queue): a server window starts from none of it and leaves none behind.
 * The queue panels' open state is an app-wide preference and stays.
 */
const VIEW_RESET: Partial<AppState> = {
  globalPanelOpen: false,
  globalView: 'sessions',
  botView: OFF_VIEW,
  botEvents: [],
  serverStatus: {},
  environments: {},
  envBusy: {},
  linearIssues: {},
  voicePlaying: null,
  voiceQueued: 0
}

export function installV2Window(entryId: string, projectId: string): V2Window {
  /** Set by `leave()`: whatever starts afterwards (a chained second request, a new wait) stops at once. */
  let left = false
  /**
   * The waits still open; `leave()` ends them, so a create or a start in
   * flight never checks the next window's store (another project, or a legacy
   * one) for its result.
   */
  const waits = new Set<() => void>()
  function whenProjected<T>(check: () => T | undefined, rev?: TopicRev): Promise<T | undefined> {
    if (left) return Promise.resolve(undefined)
    const now = check()
    if (now !== undefined) return Promise.resolve(now)
    const mirror = registered()?.mirror
    if (rev && mirror) return untilRev(mirror, rev).then(() => (left ? undefined : check()))
    return new Promise((resolve) => {
      const done = (value: T | undefined): void => {
        clearTimeout(timer)
        unsubscribe()
        waits.delete(cancel)
        resolve(value)
      }
      const cancel = (): void => done(undefined)
      waits.add(cancel)
      const unsubscribe = useAppStore.subscribe(() => {
        const value = check()
        if (value !== undefined) done(value)
      })
      const timer = setTimeout(cancel, PROJECTION_WAIT_MS)
    })
  }

  /**
   * The mirror holds `rev` (its listener has applied it to the store by the
   * time this resolves), or the wait ended: a timeout, the topic gone or
   * unsubscribed, the connection closed, or `leave()`. Never rejects.
   */
  function untilRev(mirror: TopicMirror, rev: TopicRev): Promise<void> {
    return new Promise((resolve) => {
      const done = (): void => {
        waits.delete(done)
        resolve()
      }
      waits.add(done)
      mirror.whenRev(rev.topic, rev.rev, { timeoutMs: REV_WAIT_MS }).then(done, done)
    })
  }

  // Never connects: ServerProjectWindow does, once it knows the entry still exists.
  const registered = () => registeredServerEntry(entryId)
  const request: V2Request = (method, params) => {
    const server = left ? undefined : registered()
    if (!server) return Promise.reject(new ClientError('NOT_CONNECTED', 'not connected to the server'))
    return server.connection.request(method, params)
  }
  const requestWithRev: V2RequestWithRev = (method, params) => {
    const server = left ? undefined : registered()
    if (!server) return Promise.reject(new ClientError('NOT_CONNECTED', 'not connected to the server'))
    return server.connection.requestWithRev(method, params)
  }

  /** The path the server registered, from its `server` topic (the mirror already follows it). */
  const registeredRepoPath = (repoId: string): Promise<string | null> => {
    const server = left ? undefined : registered()
    if (!server) return Promise.resolve(null)
    return new Promise((resolve) => {
      let settled = false
      let off: (() => void) | null = null
      const done = (path: string | null): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        off?.()
        waits.delete(cancel)
        resolve(path)
      }
      // `leave()` ends it like the projection waits.
      const cancel = (): void => done(null)
      waits.add(cancel)
      const timer = setTimeout(cancel, PROJECTION_WAIT_MS)
      off = server.mirror.subscribe('server', (update) => {
        if ('error' in update) return
        const repo = update.snapshot.repos.find((r) => r.id === repoId)
        if (repo) done(repo.path)
      })
      if (settled) off()
    })
  }

  // While the link is down every request fails NOT_CONNECTED, and the commands are disabled: no dialog for that.
  // The backend's fire-and-forget methods and the setter overrides share it.
  // Once the window left the project, nothing this backend still has in flight shows a dialog.
  const showError = (title: string, message: string): Promise<void> =>
    left ? Promise.resolve() : window.api.showError(title, message)
  const report = (title: string, err: unknown): void => {
    if (errorCode(err) !== 'NOT_CONNECTED') void showError(title, errorText(err))
  }
  // An edit the link dropped under says so (Notes for 3c-3 #13); one dialog at a time.
  const reportEdit = editReporter(showError, report)

  const backend = createV2Backend({
    projectId,
    request,
    requestWithRev,
    capabilities: () => registered()?.connection.welcome?.capabilities,
    ids: v2Ids,
    state: () => useAppStore.getState(),
    whenProjected,
    termSize: terminalSize,
    focus: focusTerminal,
    setActiveTerminal: (worktreeId, terminalId) => useAppStore.getState().setActiveTerminal(worktreeId, terminalId),
    confirm: (prompt) => (left ? Promise.resolve(false) : window.api.confirm(prompt)),
    showError,
    promptRepoPath: requestRepoPath,
    registeredRepoPath,
    removalBlock,
    report,
    left: () => left
  })

  // The store's own setters (zustand 5's initial state), never a live value that may already be an override.
  const initial = useAppStore.getInitialState()
  const originals = Object.fromEntries(OVERRIDDEN_SETTERS.map((name) => [name, initial[name]])) as SetterOverrides
  // Offline until ServerProjectWindow reports the real status: the commands start disabled.
  useAppStore.setState({
    ...v2SetterOverrides(backend, () => useAppStore.getState(), { report, reportEdit }),
    ...VIEW_RESET,
    serverOffline: true,
    serverLink: null
  })

  return {
    entryId,
    projectId,
    backend,
    leave: () => {
      left = true
      cancelRepoPath()
      for (const cancel of [...waits]) cancel()
      disposeV2Terminals()
      clearV2Projection()
      useAppStore.setState({ ...originals, ...EMPTY, ...VIEW_RESET })
    }
  }
}
