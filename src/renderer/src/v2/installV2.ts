// Puts a window into server-project mode and takes it out again. windowKind.ts
// calls it whenever `serverWindow` changes, inside the same `set`, so the
// backend, the store-setter overrides and the projected slice always change
// together: a window that goes back to the picker never keeps v2 overrides on
// a legacy backend, nor a projected project the legacy Workspace would render.
import { useAppStore } from '../store'
import { disposeV2Terminals, focusTerminal, terminalSize } from '../terminals'
import { removalBlock } from '../repositoryActions'
import { localWorktreeTeardown } from '../worktreeActions'
import { createV2Backend, type V2Request, type V2RequestWithRev } from './backendV2'
import { OVERRIDDEN_SETTERS, v2SetterOverrides, type SetterOverrides } from './setterOverrides'
import { applyV2Project, clearV2Projection, setV2ProjectOverlay, v2Ids } from './applyProjection'
import { registeredServerEntry } from './serverClients'
import { cancelRepoPath, requestRepoPath } from './repoPathPrompt'
import { editReporter, errorCode, errorText } from './errors'
import { agentsFetchKey, agentsRetryDelay, agentsStale } from './sessionChoices'
import { createNoteDrafts, setV2NoteDrafts } from './noteDrafts'
import { createSettingsWriter, type ConflictChoice } from './settingsWriter'
import { SETTINGS_SETTERS, v2SettingsOverrides, type SettingsOverrides, type SettingsRequests } from './settingsOverrides'
import { ClientError } from '../../../shared/client/index.ts'
import { LOCAL_ENTRY_ID } from '../../../shared/appServerRules'
import { createProjectionWaits, PROJECTION_WAIT_MS } from './projectionWaits'
import { installPatch, leavePatch } from './windowState'
import { stopAllSummaries } from '../voice'
import type { WindowBackend } from '../backend'
import type { AppState } from '../store'
import type { Project } from '../../../shared/model/types'

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
    localEntry: entryId === LOCAL_ENTRY_ID,
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
    teardown: localWorktreeTeardown,
    report,
    reportEdit,
    left: () => left
  })

  // Settings edits: one compare-and-set per field, shown as pending (the overlay) until the
  // mirror holds the server's answer; a CONFLICT asks Reload or Keep Mine (settingsWriter.ts).
  const topic = `project:${projectId}` as const
  const mirrorProject = (): Project | undefined => (left ? undefined : registered()?.mirror.get(topic)?.snapshot)
  // Each resolves once the mirror holds its rev, or once that wait ends without it (a timeout, the
  // connection closed, `leave()`): the request already succeeded, so the server has the value. The
  // writer then drops the pending edit, and the field may show the mirror's older value for a
  // moment, until the mirror catches up (its next patch, or the snapshot after a reconnect).
  // Nothing is sent or lost meanwhile, but a text field focused during that flash takes the older
  // value as its base, or sees it replace its base: a changed draft committed then reads as stale
  // and asks Reload or Keep Mine (the writer skips the dialog if, by the time it would show, the
  // mirror already holds the draft). After `leave()`, `left` stops the re-projection too.
  const settingsRequests: SettingsRequests = {
    updateSettings: async (settings, expected) => {
      const { rev } = await requestWithRev('project.updateSettings', { projectId, settings, expected })
      if (rev) await whenProjected(() => true, rev)
    },
    rename: async (name, expected) => {
      const { rev } = await requestWithRev('project.rename', { projectId, name, expected })
      if (rev) await whenProjected(() => true, rev)
    },
    setLinkedDirs: async (repoId, linkedDirs, expected) => {
      const { rev } = await requestWithRev('repo.update', { projectId, repoId, linkedDirs, expected: { linkedDirs: expected } })
      if (rev) await whenProjected(() => true, rev)
    },
    setEnvironments: async (repoId, environments, expected) => {
      const { rev } = await requestWithRev('repo.update', { projectId, repoId, environments, expected: { environments: expected } })
      if (rev) await whenProjected(() => true, rev)
    }
  }
  const askConflict = async (label: string): Promise<ConflictChoice> => {
    if (left) return 'reload'
    const keep = await window.api.confirm({
      title: 'Setting changed elsewhere',
      message: `${label} was changed on the server while you were editing it.`,
      detail: "Reload shows the server's version and drops your change. Keep Mine saves yours over it.",
      confirmLabel: 'Keep Mine',
      cancelLabel: 'Reload',
      defaultCancel: true
    })
    return keep && !left ? 'keep' : 'reload'
  }
  const settingsWriter = createSettingsWriter({
    project: mirrorProject,
    // Projects the mirror again, so the pending edits show (or go) at once.
    changed: () => {
      const server = left ? undefined : registered()
      const state = server?.mirror.get(topic)
      if (server && state) applyV2Project(state.snapshot, server.ptys)
    },
    askConflict,
    reload: () => {
      if (!left) useAppStore.setState((s) => ({ settingsReload: s.settingsReload + 1 }))
    },
    reportEdit
  })
  setV2ProjectOverlay(settingsWriter.overlay)

  // server.agents, for the New session menu and the Global bar: slow the first time (a login
  // shell per program on the server), so asked when the link comes up rather than when a menu
  // opens, and again on each reconnect and claudeCommand edit (agentsFetchKey). The last answer
  // stays meanwhile, unless the server came back without `agents` (agentsStale). A failed one is
  // asked again after a short back-off (agentsRetryDelay), then not until the key changes.
  let agentsKey: string | null = null
  let agentsRetry: ReturnType<typeof setTimeout> | null = null
  const fetchAgents = (key: string, attempt: number): void => {
    request('server.agents', { projectId }).then(
      (agents) => {
        if (!left && agentsKey === key) useAppStore.setState({ serverAgents: agents })
      },
      () => {
        const delay = agentsRetryDelay(attempt + 1)
        if (left || agentsKey !== key || delay === null) return
        agentsRetry = setTimeout(() => {
          agentsRetry = null
          if (!left && agentsKey === key) fetchAgents(key, attempt + 1)
        }, delay)
      }
    )
  }
  const followAgents = (state: AppState): void => {
    const capabilities = registered()?.connection.welcome?.capabilities
    // Checked against the store first: setState notifies every time, so this must not loop.
    if (state.serverAgents !== null && agentsStale({ link: state.serverLink, capabilities })) {
      useAppStore.setState({ serverAgents: null })
    }
    const key = agentsFetchKey({
      link: state.serverLink,
      hasProject: state.project !== null,
      capabilities,
      claudeCommand: state.project?.claudeCommand
    })
    if (key === agentsKey) return
    agentsKey = key
    if (agentsRetry !== null) clearTimeout(agentsRetry)
    agentsRetry = null
    if (key === null) return
    fetchAgents(key, 0)
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
  const originals = Object.fromEntries(
    [...OVERRIDDEN_SETTERS, ...SETTINGS_SETTERS].map((name) => [name, initial[name]])
  ) as SetterOverrides & SettingsOverrides
  // Offline until ServerProjectWindow reports the real status: the commands start disabled.
  stopAllSummaries()
  useAppStore.setState(
    installPatch({
      ...v2SetterOverrides(backend, () => useAppStore.getState(), { report, reportEdit }),
      ...v2SettingsOverrides(settingsWriter, settingsRequests, mirrorProject)
    })
  )

  return {
    entryId,
    projectId,
    backend,
    leave: () => {
      // While requests still go out: a Settings text field being edited commits its draft on
      // blur (SettingText; React runs the handler synchronously), and each unsaved note draft
      // is sent once more, or its text shown. Their answers are ignored once the window left.
      // A stale draft (its value changed elsewhere while typed) is dropped here, not asked
      // about: its dialog would come after `left`, where askConflict answers Reload.
      const active = document.activeElement
      if (active instanceof HTMLElement && active.closest('.settings-panel')) active.blur()
      drafts.leave()
      setV2NoteDrafts(null)
      offDrafts()
      left = true
      settingsWriter.clear()
      setV2ProjectOverlay(null)
      offAgents()
      if (agentsRetry !== null) clearTimeout(agentsRetry)
      cancelRepoPath()
      cancelAll()
      disposeV2Terminals()
      clearV2Projection()
      stopAllSummaries()
      useAppStore.setState(leavePatch(originals))
    }
  }
}
