import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron'
import type {
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
  OpenedProject,
  ProjectFile,
  PtyDataEvent,
  PtyDetachedEvent,
  PtyExitEvent,
  PtyResetEvent,
  PtySpawnOptions,
  ServerConfig,
  ServerStatusEvent,
  ServerTestResult,
  SkillInfo,
  StackLogChunk,
  StackStatus,
  VoiceConfig,
  VoiceInfo,
  VoiceKeyResult,
  VoiceSettings,
  WorktreeStatus
} from '../shared/types'

function subscribe<T>(channel: string, callback: (payload: T) => void): () => void {
  const listener = (_event: IpcRendererEvent, payload: T): void => callback(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api = {
  // Project file
  openProject: (): Promise<OpenedProject | null> => ipcRenderer.invoke('project:open'),
  openProjectPath: (filePath: string): Promise<OpenedProject> =>
    ipcRenderer.invoke('project:openPath', filePath),
  getRecentProjects: (): Promise<string[]> => ipcRenderer.invoke('recents:get'),
  focusWindow: (): Promise<void> => ipcRenderer.invoke('window:focus'),
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

  // ElevenLabs voice summaries — the API key stays in the main process
  voiceGetSettings: (): Promise<VoiceSettings> => ipcRenderer.invoke('voice:getSettings'),
  voiceSetApiKey: (apiKey: string): Promise<VoiceKeyResult> =>
    ipcRenderer.invoke('voice:setApiKey', apiKey),
  voiceClearApiKey: (): Promise<void> => ipcRenderer.invoke('voice:clearApiKey'),
  voiceListVoices: (): Promise<VoiceInfo[]> => ipcRenderer.invoke('voice:listVoices'),
  voiceSetConfig: (patch: Partial<VoiceConfig>): Promise<VoiceConfig> =>
    ipcRenderer.invoke('voice:setConfig', patch),
  voiceSynthesize: (text: string): Promise<Uint8Array> => ipcRenderer.invoke('voice:synthesize', text),

  // Remote servers
  connectServer: (config: ServerConfig): Promise<void> =>
    ipcRenderer.invoke('server:connect', config),
  disconnectServer: (serverId: string): Promise<void> =>
    ipcRenderer.invoke('server:disconnect', serverId),
  removeServer: (serverId: string): Promise<void> => ipcRenderer.invoke('server:remove', serverId),
  setServerToken: (serverId: string, token: string): Promise<void> =>
    ipcRenderer.invoke('server:setToken', serverId, token),
  hasServerToken: (serverId: string): Promise<boolean> =>
    ipcRenderer.invoke('server:hasToken', serverId),
  testServer: (opts: {
    url: string
    token?: string
    serverId?: string
    repoPath: string
  }): Promise<ServerTestResult> => ipcRenderer.invoke('server:test', opts),
  onServerStatus: (callback: (event: ServerStatusEvent) => void): (() => void) =>
    subscribe('server:status', callback),

  // Dialogs
  confirm: (opts: {
    title: string
    message: string
    detail?: string
    confirmLabel: string
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
  onMcpCall: (callback: (request: McpCallRequest) => void): (() => void) =>
    subscribe('mcp:call', callback),
  sendMcpResult: (callId: string, response: McpCallResponse): void =>
    ipcRenderer.send('mcp:result', callId, response),

  // Menu events
  onMenu: (
    channel:
      | 'new-project'
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
