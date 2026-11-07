import type { RawProjectFile } from './migration'
import type { LlmSelection } from './providers/types'
import type { ConnectionStatus } from './client/connection'

/** A workflow tag assignable to a branch's worktree, configured per project. */
export interface WorktreeTag {
  id: string
  name: string
  /** Hex color, e.g. "#5dabef" — the chip's text, with a translucent background */
  color: string
}

/**
 * Tags a project starts with, in workflow order. Their ids are their names so
 * branchTags written before tags were configurable still resolve.
 */
export const DEFAULT_WORKTREE_TAGS: WorktreeTag[] = [
  { id: 'In Progress', name: 'In Progress', color: '#5dabef' },
  { id: 'In Review', name: 'In Review', color: '#b8a8f0' },
  { id: 'Changes Needed', name: 'Changes Needed', color: '#ff8589' },
  { id: 'Waiting for SQL', name: 'Waiting for SQL', color: '#e2a336' },
  { id: 'In Testing', name: 'In Testing', color: '#55c7e4' },
  { id: 'Ready for Dev', name: 'Ready for Dev', color: '#b8b8b8' },
  { id: 'Ready to Deploy', name: 'Ready to Deploy', color: '#5bb98b' },
  { id: 'Remove', name: 'Remove', color: '#ff7eb0' }
]

/** User-configured quick button shown under every terminal. */
export interface TerminalQuickButton {
  id: string
  /** Button caption */
  label: string
  /** Free-form text pasted into the terminal's input when clicked */
  text: string
}

/** User-configured kind of session, offered by the new-session (+) menu. */
export interface SessionType {
  id: string
  /** Menu label, and the new session's tab title */
  name: string
  /** Appended to the agent's system prompt (Claude: --append-system-prompt) */
  systemPrompt: string
  /** Sent as the first message when a session of this type starts */
  initialMessage?: string
  /** PNG data URL shown on the tabs of sessions of this type */
  icon?: string
  /** Provider/model/effort for sessions of this type; unset = the default */
  llm?: LlmSelection
}

/** @deprecated Use SessionType. */
export type ClaudeSessionType = SessionType

export interface PersistedTerminal {
  title: string
  /** Claude Code session UUID — relaunches resume this session via --resume */
  sessionId: string
  /**
   * Remote terminals only: the daemon-side pty id. If the pty is still
   * running on the server at restore time, the app reattaches to it instead
   * of spawning a fresh claude --resume.
   */
  ptyId?: string
  /** Queued prompt blocks waiting to be sent to this terminal, oldest first */
  queue?: string[]
  /** Session type's system prompt, re-appended on every resume */
  systemPrompt?: string
  /** Session type the session was started from — its icon shows on the tab */
  sessionTypeId?: string
  /** Agent the session runs; resumes always use it. Missing = Claude (older files). */
  llm?: LlmSelection
}

export interface WorktreeInstance {
  id: string
  /** Display name, defaults to branch or directory name */
  name: string
  /** Absolute path to the worktree checkout — on its host's filesystem */
  path: string
  /** Server this worktree lives on; undefined = the local machine */
  serverId?: string
  branch?: string
  /** Terminal sessions captured at save time, restored on open */
  terminals?: PersistedTerminal[]
}

/**
 * A remote machine running the companion daemon (server/). The access token
 * is deliberately NOT here — the .trekproj is plain JSON; tokens live in
 * Electron safeStorage keyed by server id.
 */
export interface ServerConfig {
  id: string
  /** Display name, e.g. "build-box" */
  name: string
  /** wss://host[:port] — plain ws:// is only accepted for loopback */
  url: string
}

export type HostStatus =
  | 'connected'
  | 'connecting'
  | 'disconnected'
  | 'needs-auth' // no token stored on this machine for the server
  | 'error'

export interface ServerStatusEvent {
  serverId: string
  status: HostStatus
  error?: string
}

export interface ServerTestResult {
  ok: boolean
  error?: string
  daemonVersion?: string
  /** Whether the tested repository path is in the daemon's allowlist */
  repoOk?: boolean
  claudeAvailable?: boolean
  claudeVersion?: string
}

/** An app-wide trek-server (protocol v2) as the renderer sees it: never the token. */
export interface AppServerInfo {
  /** Client-side id */
  id: string
  name: string
  url: string
  hasToken: boolean
}

/**
 * One entry of main's `appServers:changed` broadcast: the entry as the list
 * has it, and main's own connection to it. `status` is null without a token
 * (main does not connect). Never a token: only `hasToken`.
 */
export interface AppServerLink {
  id: string
  name: string
  url: string
  hasToken: boolean
  /** main's connection's status, or null with no connection */
  status: ConnectionStatus | null
  message: string
  /** From the connection's last welcome */
  serverName?: string
  capabilities?: string[]
}

/** `appServers:changed`, and `appServers:links`' answer. `seq` grows with each one: a window keeps the highest. */
export interface AppServersChanged {
  seq: number
  servers: AppServerLink[]
}

/**
 * `v2socket:open`: the relay socket's id, or why there is none. `removed` means
 * the server entry is gone for good (terminal); any other refusal is transient.
 */
export type V2SocketOpenResult = { ok: true; socketId: string } | { ok: false; removed: boolean; reason: string }

/** The result of a one-shot v2 connection test. */
export interface AppServerTest {
  status: string
  message: string
  serverName?: string
  daemonVersion?: string
  capabilities?: string[]
}

/** Identifies a worktree across machines — path alone is ambiguous. */
export interface WorktreeLocator {
  serverId?: string
  path: string
}

export const hostKey = (serverId?: string): string => serverId ?? 'local'

export const worktreeKey = (loc: WorktreeLocator): string =>
  `${hostKey(loc.serverId)} ${loc.path}`

export const sameWorktree = (a: WorktreeLocator, b: WorktreeLocator): boolean =>
  a.path === b.path && (a.serverId ?? undefined) === (b.serverId ?? undefined)

/** One git repository in a project, with the data that belongs to it. */
export interface Repository {
  id: string
  /** Section title in the sidebar, defaults to the directory name */
  name: string
  /** Absolute path to the main checkout on the local machine */
  path: string
  /** Server id → absolute path of this repository's clone on that server */
  serverPaths?: Record<string, string>
  worktrees: WorktreeInstance[]
  /** Terminal sessions of the primary (main repo) tab, captured at save time */
  primaryTerminals?: PersistedTerminal[]
  /** Free-form notes, keyed by branch name */
  branchNotes?: Record<string, string>
  /**
   * Workflow tag ids, keyed by branch name — so a tag survives the worktree
   * being promoted to primary, deleted and re-created, etc.
   */
  branchTags?: Record<string, string>
  /** Enabled custom tag ids, keyed by branch name */
  branchCustomTags?: Record<string, string[]>
  /**
   * Linked tickets, keyed by branch name (survives promote/delete): a Linear
   * issue identifier ("TOW-123") or a numeric Azure DevOps work item id.
   */
  branchTickets?: Record<string, string>
  /** GitHub pull request URLs, keyed by branch name (survives promote/delete) */
  branchPullRequests?: Record<string, string>
  /**
   * Environment variables for the branch's Docker environment, keyed by branch
   * name (survives promote/delete). Raw .env-style text ("KEY=value" lines) —
   * injected into the docker compose process env for variable substitution.
   */
  branchEnvVars?: Record<string, string>
  /**
   * Repo-relative paths (e.g. ".trek") symlinked from the main repository
   * into every newly created worktree — for local-only folders like database
   * backups and secrets that aren't committed.
   */
  linkedDirs?: string[]
  /** Per-worktree isolated Docker environments (Colima VMs) */
  environments?: EnvironmentSettings
}

export interface BotSettings {
  enabled: boolean
  /** Set when the user located the folder; otherwise it sits next to the project file. */
  folder?: string
}

export interface ProjectFile {
  version: 3
  name: string
  /** At least one entry. The first holds Global Claude's working directory. */
  repositories: Repository[]
  /** Command launched in each terminal (defaults to "claude") */
  claudeCommand?: string
  /** Extra flags for every claude launch — overrides claudePermissionMode when set */
  claudeArgs?: string
  /** --permission-mode for new Claude sessions (defaults to "auto") */
  claudePermissionMode?: string
  /** Remote servers running the companion daemon */
  servers?: ServerConfig[]
  /** Favorited docker containers, by container name */
  dockerFavorites?: string[]
  /** Azure DevOps org/project URL, e.g. https://dev.azure.com/org/Project */
  azureDevOpsBaseUrl?: string
  /** Linear workspace slug (linear.app/<slug>/...) — turns issue identifiers into links */
  linearWorkspace?: string
  /** Workflow tags offered for worktrees, in order (undefined = DEFAULT_WORKTREE_TAGS) */
  worktreeTags?: WorktreeTag[]
  /** Custom tags, any number of which can be toggled on per branch */
  customTags?: WorktreeTag[]
  /** Play a sound when Claude becomes ready for input (default off) */
  audioAlerts?: boolean
  /** Background of the window's top bar, #rrggbb (undefined = default) */
  titleBarColor?: string
  /** Shown beside the project name in the top bar, as a data:image/ URL */
  logoImage?: string
  /** Shown at the top of the sidebar, as a data:image/ URL */
  bannerImage?: string
  /** Quick buttons shown under every terminal — clicking pastes the text into the input */
  terminalButtons?: TerminalQuickButton[]
  /** Quick buttons shown under the global Claude terminal instead of terminalButtons */
  globalTerminalButtons?: TerminalQuickButton[]
  /** Appended to the global Claude session's built-in system prompt */
  globalSystemPrompt?: string
  /** Project bot. Saved with the project; `saveProject` spreads the whole object. */
  bot?: BotSettings
  /** Appended to every worktree Claude session's system prompt (not the global session) */
  sessionSystemPrompt?: string
  /** Session types offered by the new-session (+) menu */
  sessionTypes?: SessionType[]
  /** Default provider/model/effort for new sessions — overrides the app-wide default */
  llmDefault?: LlmSelection
  /** Provider for new Global panel tabs (must support MCP); falls back to the session default */
  globalLlm?: LlmSelection
  /** Sidebar order, as worktreeKey()s — worktrees not listed sort after these */
  worktreeOrder?: string[]
  /** Tabs of the global (project-wide) Claude panel, in tab order */
  globalSessions?: GlobalSession[]
}

export interface GlobalSession {
  /** Claude session UUID */
  sessionId: string
  title: string
  /** Agent the tab runs. Missing = Claude. */
  llm?: LlmSelection
}

/** What a new window starts with. */
export interface InitialWindowState {
  opened: OpenedProject | null
  menu: 'open-project' | null
  /** Set when the window holds a server project; `opened` is then null. */
  server: { serverEntryId: string; projectId: string } | null
}

/** One entry in recent-projects.json: a project file, or a project on an app-wide trek-server. */
export type RecentEntry =
  | { kind: 'file'; path: string }
  | { kind: 'server'; serverEntryId: string; projectId: string; name: string; serverName: string }

export interface OpenedProject {
  filePath: string
  /** As read from disk: setProject migrates it, so it may still be an older version. */
  project: RawProjectFile
}

export interface GitWorktreeInfo {
  path: string
  /** Stamped by the multi-host aggregation layer; undefined = local */
  serverId?: string
  /** Stamped by the same layer as serverId: the repository this row belongs to */
  repoId?: string
  branch?: string
  head?: string
  isMain: boolean
  /**
   * git reports the worktree's directory as gone (`prunable` in the porcelain
   * listing): it is registered but cannot be used until pruned.
   */
  prunable?: boolean
  /**
   * Dirty/ahead/behind are NOT filled in by listWorktrees — that would cost
   * two git processes per worktree on every poll. They are merged in from the
   * slower worktreeStatuses sweep, and stay undefined until it has run.
   */
  dirty?: boolean
  /** Commits ahead of upstream (undefined when there is no upstream) */
  ahead?: number
  /** Commits behind upstream (undefined when there is no upstream) */
  behind?: number
}

/**
 * Per-worktree git state, polled separately from the worktree list: reading it
 * costs a `git status` and a `git rev-list` in every worktree, so with many
 * worktrees this is the expensive half and runs on a much slower cadence.
 */
export interface WorktreeStatus {
  path: string
  /** Uncommitted changes present (undefined when unreadable) */
  dirty?: boolean
  ahead?: number
  behind?: number
}

export type ChangedFileStatus = 'added' | 'modified' | 'deleted' | 'renamed'

export interface ChangedFile {
  path: string
  /** Previous path, for renames */
  oldPath?: string
  status: ChangedFileStatus
  added: number
  deleted: number
  binary: boolean
  /** Untracked file too large to read on each poll; no line counts */
  tooLarge?: boolean
  /** Untracked file that could not be read (e.g. permissions); no line counts */
  unreadable?: boolean
}

/** What a worktree would add to the default branch, uncommitted work included. */
export interface WorktreeChanges {
  /** The default branch compared against; null when comparing to HEAD */
  base: string | null
  files: ChangedFile[]
}

export interface SkillInfo {
  /** Slash-command name, without the leading "/" */
  name: string
  description?: string
  source: 'project' | 'user'
  /** skill = .claude/skills/<name>/SKILL.md, command = .claude/commands/<name>.md */
  kind: 'skill' | 'command'
}

export interface ContainerInfo {
  id: string
  name: string
  image: string
  /** docker state: running, exited, paused, restarting, created, dead */
  state: string
  /** human status line, e.g. "Up 2 hours (healthy)" */
  status: string
  ports: string
}

export type ContainerAction = 'start' | 'stop' | 'restart'

export interface DockerLogEvent {
  data: string
  /** true on the final event of a compose run */
  done?: boolean
}

/** Settings for per-worktree isolated Docker environments (Colima VMs). */
export interface EnvironmentSettings {
  /** Feature opt-in (default off) */
  enabled: boolean
  /** VM CPUs (default 2) */
  cpu?: number
  /** VM memory in GiB (default 4) */
  memory?: number
  /** VM disk in GiB (default 20) */
  disk?: number
  /**
   * Give each VM its own reachable IP via --network-address (default on).
   * Needs Colima's vmnet sudo helper; when off, ports forward to localhost
   * and fixed host ports collide across worktrees again.
   */
  networkAddress?: boolean
  /**
   * Run x86_64 images via Rosetta 2 (default off). Switches new VMs to
   * Apple's VZ runtime (--vm-type vz --vz-rosetta); Apple Silicon only.
   */
  rosetta?: boolean
  /**
   * Compose file path relative to the worktree (default "docker-compose.yml").
   * May be a comma-separated list — each file becomes a -f flag, layered in
   * order (e.g. "docker-compose.yml,docker-compose.override.yml").
   */
  composeFile?: string
}

export type EnvVmState = 'running' | 'stopped' | 'missing'

/** A known environment: registry entry merged with live `colima list` state. */
export interface EnvironmentInfo {
  profile: string
  repoPath: string
  branch: string
  worktreePath: string
  vmState: EnvVmState
  /** VM IP when running with --network-address */
  address?: string
  /** Compose file(s) the environment was last started with (comma-separated) */
  composeFile?: string
  /**
   * Registry entry whose worktree no longer exists on disk, or a twb- Colima
   * profile with no registry entry (e.g. left behind by a crash).
   */
  orphaned?: boolean
}

export interface EnvServicePort {
  published: number
  target: number
  protocol: string
}

/**
 * A worktree's dev stack from the repo's docker/stack/stack.sh (one compose
 * project per checkout on the shared Docker, ports from a registry block).
 */
export interface StackStatus {
  /** The worktree has docker/stack/stack.sh */
  available: boolean
  /** Stack slug — compose project is trek-<slug> */
  slug?: string
  /** First port of the stack's block; undefined until its first `up` */
  port?: number
  /** Running containers in the stack's compose project */
  containers: number
  /** A `stack.sh up` process is alive (it stays attached while the stack runs) */
  upRunning: boolean
  stopping: boolean
  /** trek/admin is cloned for this stack, so it serves on port + 5 */
  hasAdmin: boolean
  /** The stack has run here, so `stack.sh destroy` has a database and volumes to remove */
  created: boolean
}

export interface StackLogChunk {
  /** Identifies the log file; each start writes a new one */
  fileId: number
  text: string
  offset: number
}

/** One compose service inside an environment. */
export interface EnvService {
  name: string
  /** compose state: running, exited, ... */
  state: string
  /** human status line */
  status: string
  ports: EnvServicePort[]
}

/** Phases of an env:up run, for progress display. */
export type EnvUpStep = 'vm' | 'compose' | 'ready'

export interface EnvLogEvent {
  profile: string
  data: string
  /** true on the final event of an operation */
  done?: boolean
  /** marks the start of an env:up phase */
  step?: EnvUpStep
}

/** Result of env:up — nonzero code means failure; error is the friendly reason. */
export interface EnvUpResult {
  code: number
  /** VM IP when running with --network-address */
  address?: string
  error?: string
}

export interface EnvCheckResult {
  ok: boolean
  colimaVersion?: string
  dockerVersion?: string
  /** why the toolchain is unusable, e.g. "colima not found on PATH" */
  error?: string
}

export interface PtySpawnOptions {
  id: string
  cwd: string
  /** Command auto-typed into the shell once it starts (e.g. "claude") */
  command?: string
  /** Extra environment variables for the shell */
  env?: Record<string, string>
  cols: number
  rows: number
  /** Host to spawn on; undefined/null = local */
  serverId?: string | null
  /**
   * Remote restore: if a pty with this id is still running on the daemon,
   * attach to it (ignoring `command`) instead of spawning a new shell.
   */
  attachExisting?: boolean
}

export interface PtyDataEvent {
  id: string
  data: string
  /** Ring-buffer replay after a remote reattach — skip activity heuristics */
  replay?: true
}

export interface PtyExitEvent {
  id: string
  exitCode: number
}

/** Remote pty's connection dropped — the session is still running. */
export interface PtyDetachedEvent {
  id: string
}

/** Clear the terminal before a remote replay repaints it. */
export interface PtyResetEvent {
  id: string
}

export type TerminalStatus =
  | 'starting'
  | 'working'
  | 'attention' // claude asked a question / rang the bell
  | 'done' // output settled after activity
  | 'complete' // user marked it fully complete — status tracking paused
  | 'idle' // user has seen the latest state
  | 'exited'

/** A tool call from the MCP server, forwarded to the renderer to execute. */
export interface McpCallRequest {
  callId: string
  name: string
  args: Record<string, unknown>
}

export interface McpCallResponse {
  ok: boolean
  result?: unknown
  error?: string
}

/** A Linear issue's live title and workflow state, fetched for ticket chips. */
export interface LinearIssue {
  identifier: string
  title: string
  url: string
  /** Workflow state, e.g. "In Progress" */
  status: string
  /** Linear's state category: triage, backlog, unstarted, started, completed, canceled */
  statusType: string
  /** Hex color Linear uses for the state */
  statusColor: string
}

export type LinearKeyResult = { ok: true; user: string } | { ok: false; error: string }

/** Machine-wide ElevenLabs voice summary settings (not per project). */
export interface VoiceConfig {
  voiceId: string
  modelId: string
  /** Active plays spoken summaries; Busy (false) drops them. */
  active: boolean
  /** Tell Claude sessions to call speak_summary on their own when they finish or need the user. */
  promptSessions: boolean
}

export interface VoiceSettings extends VoiceConfig {
  hasApiKey: boolean
}

export interface VoiceInfo {
  id: string
  name: string
}

export type VoiceKeyResult = { ok: true; voices: VoiceInfo[] } | { ok: false; error: string }
