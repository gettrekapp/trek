import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron'
import type { AppSettings } from '../shared/appSettings'
import type {
  AppServerInfo,
  AppServersChanged,
  AttentionChanged,
  SessionSelect,
  V2SocketOpenResult,
  AppServerTest,
  InitialWindowState,
  RecentEntry,
} from '../shared/types'
import type { LlmSettings, LlmSettingsPatch, LocalBackend, ModelInfo } from '../shared/providers/types'

function subscribe<T>(channel: string, callback: (payload: T) => void): () => void {
  const listener = (_event: IpcRendererEvent, payload: T): void => callback(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api = {
  // Project file
  /** A recent .trekproj: imported, or the projects it became opened (here while this window is empty). */
  openProjectPath: (filePath: string): Promise<void> => ipcRenderer.invoke('project:openPath', filePath),
  /** File → Import .trekproj…'s flow from this window: its projects open here while it is empty. */
  importTrekproj: (): Promise<void> => ipcRenderer.invoke('project:import'),
  getRecentProjects: (): Promise<RecentEntry[]> => ipcRenderer.invoke('recents:get'),
  removeRecentProject: (entry: RecentEntry): Promise<RecentEntry[]> => ipcRenderer.invoke('recents:remove', entry),
  openServerProject: (
    serverEntryId: string,
    projectId: string,
    name: string,
    serverName: string
  ): Promise<{ opened: boolean }> =>
    ipcRenderer.invoke('window:openServerProject', serverEntryId, projectId, name, serverName),
  /** Main opened a server project in this (empty) window: an import, from the menu or a .trekproj. */
  onShowServer: (callback: (server: { serverEntryId: string; projectId: string }) => void): (() => void) =>
    subscribe('window:showServer', callback),
  reportTitle: (name: string | null): void => ipcRenderer.send('window:reportTitle', name),
  /** A server window gives up its target and becomes an empty window. */
  releaseTarget: (): Promise<void> => ipcRenderer.invoke('window:releaseTarget'),
  takeInitialWindowState: (): Promise<InitialWindowState> => ipcRenderer.invoke('window:takeInitial'),
  onWindowCloseRequest: (callback: () => void): (() => void) =>
    subscribe('window:close-request', callback),
  windowCloseReady: (): void => ipcRenderer.send('window:close-ready'),
  /** The answer to a close request while something must not be cut short (a worktree move): main asks the user */
  windowCloseBusy: (detail: string): void => ipcRenderer.send('window:close-busy', detail),
  selectDirectory: (title: string): Promise<string | null> =>
    ipcRenderer.invoke('dialog:selectDirectory', title),

  openInVSCode: (dirPath: string): Promise<void> =>
    ipcRenderer.invoke('app:openInVSCode', dirPath),
  revealInFinder: (dirPath: string): Promise<void> =>
    ipcRenderer.invoke('app:revealInFinder', dirPath),
  getAlertSound: (): Promise<Uint8Array | null> => ipcRenderer.invoke('app:getAlertSound'),

  // GitHub metadata lookup — always resolved from the local machine
  githubPrHeadBranch: (owner: string, repo: string, number: number): Promise<string | null> =>
    ipcRenderer.invoke('github:prHeadBranch', owner, repo, number),


  // Agent CLIs — app-wide defaults and local model lists
  llmGetSettings: (): Promise<LlmSettings> => ipcRenderer.invoke('llm:getSettings'),
  llmUpdateSettings: (patch: LlmSettingsPatch): Promise<LlmSettings> =>
    ipcRenderer.invoke('llm:updateSettings', patch),
  onLlmSettingsChanged: (callback: (settings: LlmSettings) => void): (() => void) =>
    subscribe('llm:changed', callback),
  llmFetchModels: (backend: LocalBackend, baseUrl: string): Promise<ModelInfo[]> =>
    ipcRenderer.invoke('llm:fetchModels', backend, baseUrl),


  // App-wide trek-servers (protocol v2). Tokens can be set, never read.
  appServers: {
    list: (): Promise<AppServerInfo[]> => ipcRenderer.invoke('appServers:list'),
    save: (input: { id?: string; name: string; url: string; token?: string }): Promise<AppServerInfo> =>
      ipcRenderer.invoke('appServers:save', input),
    setToken: (id: string, token: string): Promise<void> => ipcRenderer.invoke('appServers:setToken', id, token),
    remove: (id: string): Promise<void> => ipcRenderer.invoke('appServers:remove', id),
    test: (id: string): Promise<AppServerTest> => ipcRenderer.invoke('appServers:test', id),
    /** The list with main's connection statuses (never a token); `onChanged` hears every change after it. */
    links: (): Promise<AppServersChanged> => ipcRenderer.invoke('appServers:links'),
    onChanged: (callback: (snapshot: AppServersChanged) => void): (() => void) =>
      subscribe('appServers:changed', callback)
  },
  // The Local server (main's supervisor): its status comes with appServers' `local` field.
  localServer: {
    start: (): Promise<void> => ipcRenderer.invoke('localServer:start'),
    restart: (): Promise<void> => ipcRenderer.invoke('localServer:restart'),
    reset: (): Promise<void> => ipcRenderer.invoke('localServer:reset')
  },
  // App-wide preferences (app-settings.json), shared by every window.
  appSettings: {
    get: (): Promise<AppSettings> => ipcRenderer.invoke('appSettings:get'),
    update: (patch: Partial<AppSettings>): Promise<AppSettings> => ipcRenderer.invoke('appSettings:update', patch),
    onChanged: (callback: (settings: AppSettings) => void): (() => void) => subscribe('appSettings:changed', callback)
  },
  // Sessions on the app-wide servers that need the user, merged by main (no token, no URL).
  attention: {
    list: (): Promise<AttentionChanged> => ipcRenderer.invoke('attention:list'),
    onChanged: (callback: (snapshot: AttentionChanged) => void): (() => void) =>
      subscribe('attention:changed', callback),
    /** Focuses or opens the entry's project window, which then selects the session; false if it is no longer listed */
    open: (key: string): Promise<boolean> => ipcRenderer.invoke('attention:open', key),
    /** Main asks this window to show one of its sessions */
    onSelect: (callback: (select: SessionSelect) => void): (() => void) => subscribe('attention:select', callback),
    /** Clears the entry's decision, or marks it seen, through main's connection */
    dismiss: (key: string): Promise<void> => ipcRenderer.invoke('attention:dismiss', key),
    /** The sessions this window shows (a worktree tab, a Global tab): main does not notify for them while it has focus */
    viewing: (sessionIds: string[]): void => ipcRenderer.send('attention:viewing', sessionIds),
    /** Main asks for the alert sound (a new entry in a project with audio alerts on) */
    onAlert: (callback: () => void): (() => void) => subscribe('attention:alert', callback)
  },
  // v2 WebSockets relayed through main, by server entry id; main injects the token into hello.
  v2Socket: {
    open: (serverEntryId: string): Promise<V2SocketOpenResult> => ipcRenderer.invoke('v2socket:open', serverEntryId),
    send: (socketId: string, text: string): void => ipcRenderer.send('v2socket:send', socketId, text),
    close: (socketId: string, code?: number, reason?: string): void =>
      ipcRenderer.send('v2socket:close', socketId, code, reason),
    onEvent: (
      callback: (event: {
        socketId: string
        type: 'open' | 'message' | 'close' | 'error'
        data?: string
        code?: number
        reason?: string
      }) => void
    ): (() => void) => subscribe('v2socket:event', callback)
  },

  // Dialogs
  /** Resolves true for the confirm button; `cancelLabel` renames Cancel, `defaultCancel` makes it the default. */
  confirm: (opts: {
    title: string
    message: string
    detail?: string
    confirmLabel: string
    cancelLabel?: string
    defaultCancel?: boolean
  }): Promise<boolean> => ipcRenderer.invoke('dialog:confirm', opts),
  confirmWithCheckbox: (opts: {
    title: string
    message: string
    detail?: string
    confirmLabel: string
    checkboxLabel: string
    checkboxChecked: boolean
  }): Promise<{ confirmed: boolean; checked: boolean }> =>
    ipcRenderer.invoke('dialog:confirmWithCheckbox', opts),
  showError: (title: string, message: string): Promise<void> =>
    ipcRenderer.invoke('dialog:error', title, message),


  // Menu events
  onMenu: (
    channel:
      | 'new-project'
      | 'open-on-server'
      | 'new-terminal'
      | 'close-tab'
      | 'toggle-global-claude',
    callback: () => void
  ): (() => void) =>
    subscribe(`menu:${channel}`, callback)
}

export type RendererApi = typeof api

contextBridge.exposeInMainWorld('api', api)
