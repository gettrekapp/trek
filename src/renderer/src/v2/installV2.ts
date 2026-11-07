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
import { agentsFetchKey } from './sessionChoices'
import { createNoteDrafts, setV2NoteDrafts } from './noteDrafts'
import { ClientError } from '../../../shared/client/index.ts'
import { createProjectionWaits, PROJECTION_WAIT_MS } from './projectionWaits'
import { installPatch, leavePatch } from './windowState'
import { stopAllSummaries } from '../voice'
import type { WindowBackend } from '../backend'
import type { AppState } from '../store'

export interface V2Window {
  entryId: string
  projectId: string
  backend: WindowBackend
  /** Back to no project: terminals, ids, the projected slice and the setter overrides go. */
  leave(): void
}

export function installV2Window(entryId: string, projectId: string): V2Window {
  /** Set by `leave()`: whatever starts afterwards (a chained second request, a new wait) stops at once. */
  let left = false
  // Never connects: ServerProjectWindow does, once it knows the entry still exists.
  const registered = () => registeredServerEntry(entryId)
  /**
   * The waits still open; `leave()` ends them, so a create or a start in
   * flight never checks the next window's store (another project, or a legacy
   * one) for its result.
   */
  const { whenProjected, waits, cancelAll } = createProjectionWaits({
    mirror: () => registered()?.mirror,
    left: () => left,
    subscribe: (listener) => useAppStore.subscribe(listener),
    setTimeout: (run, ms) => setTimeout(run, ms),
    clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>)
  })

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
    reportEdit,
    left: () => left
  })

  // server.agents, for the New session menu and the Global bar: slow the first time (a login
  // shell per program on the server), so asked when the link comes up rather than when a menu
  // opens, and again on each reconnect and claudeCommand edit (agentsFetchKey). The last answer
  // stays meanwhile; a failed one is not retried until the key changes.
  let agentsKey: string | null = null
  const followAgents = (state: AppState): void => {
    const key = agentsFetchKey({
      link: state.serverLink,
      hasProject: state.project !== null,
      capabilities: registered()?.connection.welcome?.capabilities,
      claudeCommand: state.project?.claudeCommand
    })
    if (key === agentsKey) return
    agentsKey = key
    if (key === null) return
    request('server.agents', { projectId }).then(
      (agents) => {
        if (!left && agentsKey === key) useAppStore.setState({ serverAgents: agents })
      },
      () => {}
    )
  }
  const offAgents = useAppStore.subscribe(followAgents)

  const noteText = (repoId: string, branch: string): string =>
    useAppStore.getState().project?.repositories.find((r) => r.id === repoId)?.branchNotes?.[branch] ?? ''
  const drafts = createNoteDrafts({
    setNote: (repoId, branch, text, expected) => backend.branch.setNote(repoId, branch, text, expected),
    saved: noteText,
    offline: () => useAppStore.getState().serverOffline,
    show: (title, message) => void showError(title, message),
    // The user's own unsaved text, at leave: shown even though the window has moved on.
    showAlways: (title, message) => void window.api.showError(title, message)
  })
  setV2NoteDrafts(drafts)
  // The link is back: send what was typed while it was down, on any branch.
  const offDrafts = useAppStore.subscribe((state, previous) => {
    if (previous.serverOffline && !state.serverOffline) drafts.saveAll()
  })

  // The store's own setters (zustand 5's initial state), never a live value that may already be an override.
  const initial = useAppStore.getInitialState()
  const originals = Object.fromEntries(OVERRIDDEN_SETTERS.map((name) => [name, initial[name]])) as SetterOverrides
  // Offline until ServerProjectWindow reports the real status: the commands start disabled.
  stopAllSummaries()
  useAppStore.setState(installPatch(v2SetterOverrides(backend, () => useAppStore.getState(), { report, reportEdit })))

  return {
    entryId,
    projectId,
    backend,
    leave: () => {
      // While requests still go out: each unsaved draft is sent once more, or its text shown.
      drafts.leave()
      setV2NoteDrafts(null)
      offDrafts()
      left = true
      offAgents()
      cancelRepoPath()
      cancelAll()
      disposeV2Terminals()
      clearV2Projection()
      stopAllSummaries()
      useAppStore.setState(leavePatch(originals))
    }
  }
}
