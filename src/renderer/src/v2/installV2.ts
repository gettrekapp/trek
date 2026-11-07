// Puts a window into server-project mode and takes it out again. windowKind.ts
// calls it whenever `serverWindow` changes, inside the same `set`, so the
// backend, the store-setter overrides and the projected slice always change
// together: a window that goes back to the picker never keeps v2 overrides on
// a legacy backend, nor a projected project the legacy Workspace would render.
import { useAppStore } from '../store'
import { disposeV2Terminals, focusTerminal, terminalSize } from '../terminals'
import { removalBlock } from '../repositoryActions'
import { createV2Backend, type V2Request } from './backendV2'
import { OVERRIDDEN_SETTERS, v2SetterOverrides, type SetterOverrides } from './setterOverrides'
import { clearV2Projection, v2Ids } from './applyProjection'
import { registeredServerEntry } from './serverClients'
import { requestRepoPath } from './repoPathPrompt'
import { errorCode, errorText } from './errors'
import { ClientError } from '../../../shared/client/index.ts'
import type { WindowBackend } from '../backend'
import type { AppState } from '../store'

/** How long an action waits for its result to show up in the mirror. */
const PROJECTION_WAIT_MS = 10_000

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
  serverOffline: false
}

export function installV2Window(entryId: string, projectId: string): V2Window {
  /**
   * The waits still open; `leave()` ends them with undefined, so a create or a
   * start in flight never checks the next window's store (another project, or
   * a legacy one) for its result.
   */
  const waits = new Set<() => void>()
  function whenProjected<T>(check: () => T | undefined): Promise<T | undefined> {
    const now = check()
    if (now !== undefined) return Promise.resolve(now)
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

  // Never connects: ServerProjectWindow does, once it knows the entry still exists.
  const registered = () => registeredServerEntry(entryId)
  const request: V2Request = (method, params) => {
    const server = registered()
    if (!server) return Promise.reject(new ClientError('NOT_CONNECTED', 'not connected to the server'))
    return server.connection.request(method, params)
  }

  /** The path the server registered, from its `server` topic (the mirror already follows it). */
  const registeredRepoPath = (repoId: string): Promise<string | null> => {
    const server = registered()
    if (!server) return Promise.resolve(null)
    return new Promise((resolve) => {
      let settled = false
      let off: (() => void) | null = null
      const done = (path: string | null): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        off?.()
        resolve(path)
      }
      const timer = setTimeout(() => done(null), PROJECTION_WAIT_MS)
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
  const report = (title: string, err: unknown): void => {
    if (errorCode(err) !== 'NOT_CONNECTED') void window.api.showError(title, errorText(err))
  }

  const backend = createV2Backend({
    projectId,
    request,
    capabilities: () => registered()?.connection.welcome?.capabilities,
    ids: v2Ids,
    state: () => useAppStore.getState(),
    whenProjected,
    termSize: terminalSize,
    focus: focusTerminal,
    setActiveTerminal: (worktreeId, terminalId) => useAppStore.getState().setActiveTerminal(worktreeId, terminalId),
    confirm: (prompt) => window.api.confirm(prompt),
    showError: (title, message) => window.api.showError(title, message),
    promptRepoPath: requestRepoPath,
    registeredRepoPath,
    removalBlock,
    report
  })

  const state = useAppStore.getState()
  const originals = Object.fromEntries(OVERRIDDEN_SETTERS.map((name) => [name, state[name]])) as SetterOverrides
  useAppStore.setState(v2SetterOverrides(backend, () => useAppStore.getState(), report))

  return {
    entryId,
    projectId,
    backend,
    leave: () => {
      for (const cancel of [...waits]) cancel()
      disposeV2Terminals()
      clearV2Projection()
      useAppStore.setState({ ...originals, ...EMPTY })
    }
  }
}
