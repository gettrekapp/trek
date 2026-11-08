import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron'
import type { AppSettings } from '../shared/appSettings'
import type {
  AppServerInfo,
  AppServersChanged,
  AttentionChanged,
  SessionSelect,
  V2SocketOpenResult,
  AppServerTest,
  ContainerAction,
  ContainerInfo,
  DockerLogEvent,
  EnvCheckResult,
  EnvLogEvent,
  EnvService,
  EnvUpResult,
  EnvironmentInfo,
  EnvironmentSettings,
  GitWorktreeInfo,
  LinearIssue,
  LinearKeyResult,
  McpCallRequest,
  McpCallResponse,
  InitialWindowState,
  OpenedProject,
  ProjectFile,
  RecentEntry,
  PtyDataEvent,
  PtyDetachedEvent,
  PtyExitEvent,
  PtyResetEvent,
  PtySpawnOptions,
  ServerConfig,
  ServerStatusEvent,
  ServerTestResult,
  ServerTokenCheck,
  SkillInfo,
  StackLogChunk,
  StackStatus,
  VoiceConfig,
  VoiceInfo,
  VoiceKeyResult,
  VoiceSettings,
  WorktreeChanges,
  WorktreeStatus
} from '../shared/types'
import type { BotAttach, BotEvent, BotView } from '../shared/bot'
import type { LlmSettings, LlmSettingsPatch, LocalBackend, McpAccess, ModelInfo } from '../shared/providers/types'

function subscribe<T>(channel: string, callback: (payload: T) => void): () => void {
  const listener = (_event: IpcRendererEvent, payload: T): void => callback(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api = {
  // Project file
  openProject: (): Promise<OpenedProject | null> => ipcRenderer.invoke('project:open'),
  openProjectPath: (filePath: string): Promise<OpenedProject | null> =>
    ipcRenderer.invoke('project:openPath', filePath),
  getRecentProjects: (): Promise<RecentEntry[]> => ipcRenderer.invoke('recents:get'),
  removeRecentProject: (entry: RecentEntry): Promise<RecentEntry[]> => ipcRenderer.invoke('recents:remove', entry),
  openServerProject: (
    serverEntryId: string,
    projectId: string,
    name: string,
    serverName: string
  ): Promise<{ opened: boolean }> =>
    ipcRenderer.invoke('window:openServerProject', serverEntryId, projectId, name, serverName),
  reportTitle: (name: string | null): void => ipcRenderer.send('window:reportTitle', name),
  /** A server window gives up its target and becomes an empty window. */
  releaseTarget: (): Promise<void> => ipcRenderer.invoke('window:releaseTarget'),
  focusWindow: (): Promise<void> => ipcRenderer.invoke('window:focus'),
  takeInitialWindowState: (): Promise<InitialWindowState> => ipcRenderer.invoke('window:takeInitial'),
  reportWindowProject: (hasProject: boolean, filePath: string | null, name: string | null): void =>
    ipcRenderer.send('window:projectChanged', hasProject, filePath, name),
  onWindowCloseRequest: (callback: () => void): (() => void) =>
    subscribe('window:close-request', callback),
  windowCloseReady: (): void => ipcRenderer.send('window:close-ready'),
  windowCloseCancelled: (): void => ipcRenderer.send('window:close-cancelled'),
  promptCloseUnsaved: (name: string): Promise<'save' | 'discard' | 'cancel'> =>
    ipcRenderer.invoke('dialog:closeUnsaved', name),
  promptCloseSaveFailed: (error: string): Promise<boolean> =>
    ipcRenderer.invoke('dialog:closeSaveFailed', error),
  saveProject: (filePath: string | null, project: ProjectFile): Promise<string | null> =>
    ipcRenderer.invoke('project:save', filePath, project),
  selectDirectory: (title: string): Promise<string | null> =>
    ipcRenderer.invoke('dialog:selectDirectory', title),

  // Git — serverId null/undefined = the local machine
  listWorktrees: (serverId: string | null, repoPath: string): Promise<GitWorktreeInfo[]> =>
    ipcRenderer.invoke('git:listWorktrees', serverId, repoPath),
  /** Dirty/ahead/behind for specific worktrees — polled apart from the list. */
  worktreeStatuses: (serverId: string | null, worktreePaths: string[]): Promise<WorktreeStatus[]> =>
    ipcRenderer.invoke('git:worktreeStatuses', serverId, worktreePaths),
  worktreeChanges: (serverId: string | null, worktreePath: string): Promise<WorktreeChanges> =>
    ipcRenderer.invoke('git:worktreeChanges', serverId, worktreePath),
  worktreeDiff: (serverId: string | null, worktreePath: string): Promise<Record<string, string>> =>
    ipcRenderer.invoke('git:worktreeDiff', serverId, worktreePath),
  listBranches: (serverId: string | null, repoPath: string): Promise<string[]> =>
    ipcRenderer.invoke('git:listBranches', serverId, repoPath),
  addWorktree: (
    serverId: string | null,
    repoPath: string,
    worktreePath: string,
    branch: string,
    createBranch: boolean
  ): Promise<void> =>
    ipcRenderer.invoke('git:addWorktree', serverId, repoPath, worktreePath, branch, createBranch),
  removeWorktree: (serverId: string | null, repoPath: string, worktreePath: string): Promise<void> =>
    ipcRenderer.invoke('git:removeWorktree', serverId, repoPath, worktreePath),
  checkoutBranch: (serverId: string | null, repoPath: string, branch: string): Promise<void> =>
    ipcRenderer.invoke('git:checkout', serverId, repoPath, branch),
  openInVSCode: (dirPath: string): Promise<void> =>
    ipcRenderer.invoke('app:openInVSCode', dirPath),
  revealInFinder: (dirPath: string): Promise<void> =>
    ipcRenderer.invoke('app:revealInFinder', dirPath),
  getDefaultBranch: (serverId: string | null, repoPath: string): Promise<string | null> =>
    ipcRenderer.invoke('git:defaultBranch', serverId, repoPath),
  getAlertSound: (): Promise<Uint8Array | null> => ipcRenderer.invoke('app:getAlertSound'),

  // Worktree move support
  exportDirtyPatch: (
    serverId: string | null,
    worktreePath: string
  ): Promise<{ patch: string; headSha: string }> =>
    ipcRenderer.invoke('git:exportDirtyPatch', serverId, worktreePath),
  applyPatch: (serverId: string | null, worktreePath: string, patch: string): Promise<void> =>
    ipcRenderer.invoke('git:applyPatch', serverId, worktreePath, patch),
  revParseHead: (serverId: string | null, worktreePath: string): Promise<string> =>
    ipcRenderer.invoke('git:revParseHead', serverId, worktreePath),
  pushBranch: (serverId: string | null, worktreePath: string, branch: string): Promise<void> =>
    ipcRenderer.invoke('git:push', serverId, worktreePath, branch),
  pullBranch: (serverId: string | null, worktreePath: string, branch: string): Promise<void> =>
    ipcRenderer.invoke('git:pull', serverId, worktreePath, branch),
  fetchBranch: (serverId: string | null, repoPath: string, branch: string): Promise<void> =>
    ipcRenderer.invoke('git:fetchBranch', serverId, repoPath, branch),
  fetchPullRequestHead: (
    serverId: string | null,
    repoPath: string,
    prNumber: number,
    branch: string
  ): Promise<void> =>
    ipcRenderer.invoke('git:fetchPullRequestHead', serverId, repoPath, prNumber, branch),
  // GitHub metadata lookup — always resolved from the local machine
  githubPrHeadBranch: (owner: string, repo: string, number: number): Promise<string | null> =>
    ipcRenderer.invoke('github:prHeadBranch', owner, repo, number),
  addWorktreeAt: (
    serverId: string | null,
    repoPath: string,
    worktreePath: string,
    branch: string
  ): Promise<void> =>
    ipcRenderer.invoke('git:addWorktreeAt', serverId, repoPath, worktreePath, branch),
  removeWorktreeForce: (
    serverId: string | null,
    repoPath: string,
    worktreePath: string
  ): Promise<void> =>
    ipcRenderer.invoke('git:removeWorktreeForce', serverId, repoPath, worktreePath),
  linkWorktreeDirs: (
    serverId: string | null,
    repoPath: string,
    worktreePath: string,
    dirs: string[]
  ): Promise<void> => ipcRenderer.invoke('git:linkDirs', serverId, repoPath, worktreePath, dirs),
  exportClaudeSession: (
    serverId: string | null,
    cwd: string,
    sessionId: string
  ): Promise<string | null> => ipcRenderer.invoke('claude:exportSession', serverId, cwd, sessionId),
  importClaudeSession: (
    serverId: string | null,
    cwd: string,
    sessionId: string,
    content: string
  ): Promise<void> =>
    ipcRenderer.invoke('claude:importSession', serverId, cwd, sessionId, content),
  deleteClaudeSession: (serverId: string | null, cwd: string, sessionId: string): Promise<void> =>
    ipcRenderer.invoke('claude:deleteSession', serverId, cwd, sessionId),

  // Linear — the API key stays in the main process
  linearHasApiKey: (): Promise<boolean> => ipcRenderer.invoke('linear:hasApiKey'),
  linearSetApiKey: (apiKey: string): Promise<LinearKeyResult> =>
    ipcRenderer.invoke('linear:setApiKey', apiKey),
  linearClearApiKey: (): Promise<void> => ipcRenderer.invoke('linear:clearApiKey'),
  linearFetchIssues: (ids: string[]): Promise<LinearIssue[]> =>
    ipcRenderer.invoke('linear:fetchIssues', ids),

  // Agent CLIs — app-wide defaults and local model lists
  llmGetSettings: (): Promise<LlmSettings> => ipcRenderer.invoke('llm:getSettings'),
  llmUpdateSettings: (patch: LlmSettingsPatch): Promise<LlmSettings> =>
    ipcRenderer.invoke('llm:updateSettings', patch),
  onLlmSettingsChanged: (callback: (settings: LlmSettings) => void): (() => void) =>
    subscribe('llm:changed', callback),
  llmFetchModels: (backend: LocalBackend, baseUrl: string): Promise<ModelInfo[]> =>
    ipcRenderer.invoke('llm:fetchModels', backend, baseUrl),

  // ElevenLabs voice summaries — the API key stays in the main process
  voiceGetSettings: (): Promise<VoiceSettings> => ipcRenderer.invoke('voice:getSettings'),
  voiceSetApiKey: (apiKey: string): Promise<VoiceKeyResult> =>
    ipcRenderer.invoke('voice:setApiKey', apiKey),
  voiceClearApiKey: (): Promise<void> => ipcRenderer.invoke('voice:clearApiKey'),
  voiceListVoices: (): Promise<VoiceInfo[]> => ipcRenderer.invoke('voice:listVoices'),
  voiceSetConfig: (patch: Partial<VoiceConfig>): Promise<VoiceConfig> =>
    ipcRenderer.invoke('voice:setConfig', patch),
  voiceSynthesize: (text: string): Promise<Uint8Array> => ipcRenderer.invoke('voice:synthesize', text),

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

  // Remote servers
  connectServer: (config: ServerConfig): Promise<void> =>
    ipcRenderer.invoke('server:connect', config),
  disconnectServer: (serverId: string): Promise<void> =>
    ipcRenderer.invoke('server:disconnect', serverId),
  removeServer: (serverId: string): Promise<void> => ipcRenderer.invoke('server:remove', serverId),
  /** Stores the token bound to `url`'s origin: main never sends it to another origin. */
  setServerToken: (serverId: string, token: string, url: string): Promise<void> =>
    ipcRenderer.invoke('server:setToken', serverId, token, url),
  /** Whether a token is stored that may be sent to `url`, and if not, why. */
  hasServerToken: (serverId: string, url: string): Promise<ServerTokenCheck> =>
    ipcRenderer.invoke('server:hasToken', serverId, url),
  testServer: (opts: {
    url: string
    token?: string
    serverId?: string
    repoPath: string
  }): Promise<ServerTestResult> => ipcRenderer.invoke('server:test', opts),
  onServerStatus: (callback: (event: ServerStatusEvent) => void): (() => void) =>
    subscribe('server:status', callback),

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

  // Skills
  listSkills: (worktreePath: string): Promise<SkillInfo[]> =>
    ipcRenderer.invoke('skills:list', worktreePath),

  // Docker
  listContainers: (): Promise<ContainerInfo[]> => ipcRenderer.invoke('docker:list'),
  containerAction: (action: ContainerAction, id: string): Promise<void> =>
    ipcRenderer.invoke('docker:container', action, id),
  compose: (args: string[], cwd: string): Promise<number> =>
    ipcRenderer.invoke('docker:compose', args, cwd),
  onDockerLog: (callback: (event: DockerLogEvent) => void): (() => void) =>
    subscribe('docker:log', callback),

  // Per-worktree dev stacks (the repo's docker/stack/stack.sh)
  stackStatus: (worktreePath: string): Promise<StackStatus> =>
    ipcRenderer.invoke('stack:status', worktreePath),
  stackUp: (worktreePath: string, starter: boolean): Promise<void> =>
    ipcRenderer.invoke('stack:up', worktreePath, starter),
  stackDown: (worktreePath: string): Promise<number> =>
    ipcRenderer.invoke('stack:down', worktreePath),
  stackDestroy: (worktreePath: string): Promise<number> =>
    ipcRenderer.invoke('stack:destroy', worktreePath),
  stackLog: (worktreePath: string, fileId: number, offset: number): Promise<StackLogChunk> =>
    ipcRenderer.invoke('stack:log', worktreePath, fileId, offset),

  // Per-worktree environments (Colima VMs) — serverId must be null in v1
  envCheck: (): Promise<EnvCheckResult> => ipcRenderer.invoke('env:check'),
  envList: (serverId: string | null, repoPath: string): Promise<EnvironmentInfo[]> =>
    ipcRenderer.invoke('env:list', serverId, repoPath),
  envUp: (
    serverId: string | null,
    repoPath: string,
    branch: string,
    worktreePath: string,
    settings: EnvironmentSettings | undefined,
    envVars?: Record<string, string>
  ): Promise<EnvUpResult> =>
    ipcRenderer.invoke('env:up', serverId, repoPath, branch, worktreePath, settings, envVars),
  envStop: (serverId: string | null, profile: string): Promise<number> =>
    ipcRenderer.invoke('env:stop', serverId, profile),
  envDestroy: (serverId: string | null, profile: string): Promise<number> =>
    ipcRenderer.invoke('env:destroy', serverId, profile),
  envPs: (
    serverId: string | null,
    profile: string,
    worktreePath: string,
    composeFile?: string
  ): Promise<EnvService[]> =>
    ipcRenderer.invoke('env:ps', serverId, profile, worktreePath, composeFile),
  envComposeFiles: (serverId: string | null, worktreePath: string): Promise<string[]> =>
    ipcRenderer.invoke('env:composeFiles', serverId, worktreePath),
  envLogs: (
    serverId: string | null,
    profile: string,
    worktreePath: string,
    composeFile: string | undefined,
    service: string,
    tail?: number
  ): Promise<string> =>
    ipcRenderer.invoke('env:logs', serverId, profile, worktreePath, composeFile, service, tail),
  onEnvLog: (callback: (event: EnvLogEvent) => void): (() => void) =>
    subscribe('env:log', callback),

  // Claude sessions (host-local rename; both cwds on the same machine)
  migrateClaudeSession: (
    serverId: string | null,
    sessionId: string,
    fromCwd: string,
    toCwd: string
  ): Promise<boolean> =>
    ipcRenderer.invoke('claude:migrateSession', serverId, sessionId, fromCwd, toCwd),
  discoverCodexSession: (
    serverId: string | null,
    cwd: string,
    ageMs: number,
    exclude: string[]
  ): Promise<string | null> =>
    ipcRenderer.invoke('agents:discoverCodexSession', serverId, cwd, ageMs, exclude),
  agentCommandExists: (serverId: string | null, command: string): Promise<boolean> =>
    ipcRenderer.invoke('agents:commandExists', serverId, command),

  // Terminals
  spawnPty: (opts: PtySpawnOptions): Promise<void> => ipcRenderer.invoke('pty:spawn', opts),
  writePty: (id: string, data: string): void => ipcRenderer.send('pty:write', id, data),
  resizePty: (id: string, cols: number, rows: number): void =>
    ipcRenderer.send('pty:resize', id, cols, rows),
  disposePty: (id: string): void => ipcRenderer.send('pty:dispose', id),
  /** Unload: free the local terminal; a remote session keeps running on its server. */
  detachPty: (id: string): void => ipcRenderer.send('pty:detach', id),
  onPtyData: (callback: (event: PtyDataEvent) => void): (() => void) =>
    subscribe('pty:data', callback),
  onPtyExit: (callback: (event: PtyExitEvent) => void): (() => void) =>
    subscribe('pty:exit', callback),
  onPtyDetached: (callback: (event: PtyDetachedEvent) => void): (() => void) =>
    subscribe('pty:detached', callback),
  onPtyReset: (callback: (event: PtyResetEvent) => void): (() => void) =>
    subscribe('pty:reset', callback),

  // MCP server for the global Claude session
  /** Starts the server on first call; resolves to the --mcp-config file path. */
  getMcpConfigPath: (): Promise<string> => ipcRenderer.invoke('mcp:configPath'),
  /** Starts the server on first call; url, token and config files for any agent CLI. */
  getMcpAccess: (): Promise<McpAccess> => ipcRenderer.invoke('mcp:access'),
  onMcpCall: (callback: (request: McpCallRequest) => void): (() => void) =>
    subscribe('mcp:call', callback),
  sendMcpResult: (callId: string, response: McpCallResponse): void =>
    ipcRenderer.send('mcp:result', callId, response),

  // Project bot
  botAttach: (request: BotAttach | null): Promise<void> => ipcRenderer.invoke('bot:attach', request),
  botAllow: (): Promise<void> => ipcRenderer.invoke('bot:allow'),
  botEnable: (): Promise<void> => ipcRenderer.invoke('bot:enable'),
  botStartNew: (): Promise<void> => ipcRenderer.invoke('bot:startNew'),
  botLocate: (): Promise<{ folder: string | null; error?: string }> => ipcRenderer.invoke('bot:locate'),
  botEvents: (): Promise<BotEvent[]> => ipcRenderer.invoke('bot:events'),
  botSetPaused: (paused: boolean): Promise<void> => ipcRenderer.invoke('bot:setPaused', paused),
  botSend: (text: string): Promise<void> => ipcRenderer.invoke('bot:send', text),
  botDecide: (id: string, approved: boolean): Promise<void> => ipcRenderer.invoke('bot:decide', id, approved),
  botOpenFolder: (): Promise<void> => ipcRenderer.invoke('bot:openFolder'),
  onBotView: (callback: (view: BotView) => void): (() => void) => subscribe('bot:view', callback),
  onBotEvent: (callback: (event: BotEvent) => void): (() => void) => subscribe('bot:event', callback),

  // Menu events
  onMenu: (
    channel:
      | 'open-project'
      | 'save-project'
      | 'new-terminal'
      | 'close-tab'
      | 'toggle-global-claude',
    callback: () => void
  ): (() => void) =>
    subscribe(`menu:${channel}`, callback)
}

export type RendererApi = typeof api

contextBridge.exposeInMainWorld('api', api)
