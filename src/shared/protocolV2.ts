// Protocol v2, the wire protocol between clients (the desktop app, a future mobile app) and
// trek-server: JSON text frames over WebSocket. The server owns all project state; clients send
// domain commands and subscribe to topics (snapshot + JSON patches). See PROTOCOL.md. This file is
// the single source of truth for frame shapes. (Protocol v1, the per-call git and pty methods of
// the file windows, was retired in phase 4e: a v1 hello is refused with UPGRADE_CLIENT.)
import type {
  AttentionTopic,
  ProjectTopic,
  ServerTopic,
  Topic,
  TopicSnapshot
} from './model/topics.ts'
import type { ProjectSettings, ProjectSummary, Project } from './model/types.ts'
import type { LlmProviderId, LlmSelection } from './providers/types.ts'
import type { StatePatch } from './sync/topicState.ts'
import type { EnvironmentSettings, WorktreeChanges } from './types.ts'

export const PROTOCOL_VERSION_V2 = 2

/** Versions the server accepts in `hello`: v2 only since phase 4e. */
export const SUPPORTED_PROTOCOL_VERSIONS: readonly number[] = [2]

/** Close reason sent with code 4002 when the client is older than the server allows. */
export const CLOSE_REASON_UPGRADE_CLIENT = 'UPGRADE_CLIENT'

/** Default server port (loopback; TLS is terminated by a reverse proxy). */
export const DEFAULT_DAEMON_PORT = 7345

// WebSocket close codes (4000-range = application-defined)
export const CLOSE_HELLO_TIMEOUT = 4001
export const CLOSE_UNSUPPORTED_VERSION = 4002
export const CLOSE_UNAUTHORIZED = 4003

export type WireErrorCode =
  | 'UNAUTHORIZED'
  | 'BAD_REQUEST'
  | 'NOT_FOUND'
  | 'PATH_DENIED'
  | 'GIT_ERROR'
  | 'PTY_NOT_FOUND'
  | 'INTERNAL'
  | 'UNSUPPORTED_VERSION'
  /** An `expected` guard failed because the field changed since the client read it. */
  | 'CONFLICT'
  /** `server.addRepo` was given a path that is not inside a git repository. */
  | 'NOT_A_REPO'
  /** The server is at a session limit (`maxSessions` or the per-project session-record cap). */
  | 'CAPACITY'
  /** `server.removeRepo` on a repo that projects still use. */
  | 'IN_USE'
  /**
   * `pty.attach` from a connection that already has a large backlog unsent
   * (over 4 MiB). Nothing was replayed or attached; retry once the backlog drains.
   */
  | 'CONGESTED'

export interface WireError {
  code: WireErrorCode
  message: string
  /** A machine-readable detail of the refusal; clients ignore keys they don't know */
  details?: WireErrorDetails
}

/** What `WireError.details` may say. */
export interface WireErrorDetails {
  /**
   * `dirty`: `worktree.remove` refused a worktree with modified or untracked files.
   * The client SDK's own `TOPIC_ENDED` errors carry the `topic.ended` reason here.
   */
  reason?: string
}

/** A repository the server has registered (`trek-server add`, `server.addRepo`). */
export interface RemoteRepo {
  id: string
  name: string
  path: string
}

// ---------- client → server ----------

export interface HelloFrame {
  type: 'hello'
  protocolVersion: number
  /** Bearer token; may be omitted when sent via the Authorization header. */
  token?: string
  client: string
  clientVersion: string
}

export interface ReqFrame {
  type: 'req'
  id: number
  method: string
  params?: unknown
}

export type ClientFrame = HelloFrame | ReqFrame

// ---------- server → client ----------

export interface EventFrame {
  type: 'event'
  event: string
  payload: unknown
}

/** A pty as `pty.attach` reports it. */
export interface PtyInfo {
  ptyId: string
  cwd: string
  cols: number
  rows: number
  /** Byte offset of the next output chunk (total bytes emitted so far). */
  seq: number
}

export interface PtyDataEventWire {
  ptyId: string
  /** Byte offset of this chunk's start within the pty's lifetime output. */
  seq: number
  data: string
  /** Set on chunks re-sent from the ring buffer during attach. */
  replay?: true
}

export interface PtyExitEventWire {
  ptyId: string
  exitCode: number
}

/**
 * `welcome.capabilities` values: the features a client cannot otherwise tell a
 * server has (a method or an event). Clients hide or work around what is missing.
 */
export const CAPABILITY = {
  /** The server's MCP listener is up, so sessions get the trek-dev tools (the Global panel needs them) */
  mcp: 'mcp',
  /** The server sends `topic.ended` before a topic stops (a deleted project) */
  topicEnd: 'topicEnd',
  /** Sessions carry `decision` (MCP request_decision), and `session.dismissDecision` clears it */
  decisions: 'decisions',
  /** `session.dequeue` removes one queued prompt, compare-and-set */
  dequeue: 'dequeue',
  /** `server.agents` lists the agents the server can launch */
  agents: 'agents',
  /** This is the machine's own local server (`trek-server start --local`): it takes any path the user picks */
  local: 'local'
} as const

/** Why a topic ended (`topic.ended`). */
export type TopicEndReason = 'deleted'

export interface TopicEndedPayload {
  topic: Topic
  reason: TopicEndReason
}

export interface WelcomeFrameV2 {
  type: 'welcome'
  protocolVersion: 2
  daemonVersion: string
  /** Stable UUID of this server */
  serverId: string
  serverName: string
  /** Optional features, e.g. "mcp", "bot", "docker"; clients hide what is missing */
  capabilities: string[]
}

interface ProjectRef {
  projectId: string
}
interface RepoRef extends ProjectRef {
  repoId: string
}
interface WorktreeRef extends ProjectRef {
  worktreeId: string
}
interface SessionRef extends ProjectRef {
  sessionId: string
}
interface BranchRef extends RepoRef {
  branch: string
}

/** A shallow settings patch: a key set to null is removed. */
type SettingsPatch = { [K in keyof ProjectSettings]?: ProjectSettings[K] | null }

/**
 * Edit commands that take `expected` are compare-and-set: the server fails with
 * CONFLICT only if the field's current value differs (deep equality, null = absent).
 */
export interface MethodParamsV2 {
  // Projects
  'project.list': Record<string, never>
  'project.create': { name: string; repositories: { path: string; name?: string }[] }
  /** A project from importProjectFile(). The server assigns the project's id; nested ids are kept. */
  'project.import': { project: Project }
  'project.rename': ProjectRef & { name: string; expected?: string }
  'project.delete': ProjectRef
  /** Shallow merge into the project's settings; a key set to null is removed */
  'project.updateSettings': ProjectRef & {
    settings: SettingsPatch
    /** Only the keys listed here are compared */
    expected?: SettingsPatch
  }
  // Repositories
  'repo.add': ProjectRef & { path: string; name?: string }
  'repo.remove': RepoRef
  'repo.update': RepoRef & {
    name?: string
    linkedDirs?: string[] | null
    environments?: EnvironmentSettings | null
    expected?: {
      name?: string
      linkedDirs?: string[] | null
      environments?: EnvironmentSettings | null
    }
  }
  'repo.listBranches': RepoRef
  // Worktrees
  /**
   * `path` defaults to `<repo>-<branch>` next to the repository, each `/` in the
   * branch replaced by `-`. `fromPr`: fetch GitHub PR #n's head into `branch`
   * and check it out (works for fork PRs); needs `createBranch: false`.
   * Not atomic: if git creates the worktree but the list cannot be re-read, the
   * call fails with GIT_ERROR and the worktree stays on disk.
   */
  'worktree.create': RepoRef & {
    branch: string
    createBranch: boolean
    path?: string
    fromPr?: number
  }
  /** Without `force`, a dirty worktree fails with GIT_ERROR; a loaded one is IN_USE */
  'worktree.remove': WorktreeRef & { force?: boolean }
  /** Marks the worktree loaded and resumes its sessions that are not running */
  'worktree.load': WorktreeRef
  /** Ends the worktree's ptys and marks it unloaded; its sessions stay, idle */
  'worktree.unload': WorktreeRef
  'worktree.pull': WorktreeRef
  'worktree.push': WorktreeRef & { setUpstream: boolean }
  'worktree.changes': WorktreeRef
  'worktree.diff': WorktreeRef
  // Branch data (null clears)
  'branch.setTag': BranchRef & { tag: string | null }
  'branch.setCustomTags': BranchRef & { customTags: string[] | null }
  'branch.setNote': BranchRef & { note: string | null; expected?: string | null }
  'branch.setTicket': BranchRef & { ticket: string | null }
  'branch.setPr': BranchRef & { pr: string | null }
  'branch.setEnv': BranchRef & { env: string | null; expected?: string | null }
  // Sessions
  /** `worktreeId: null` starts a Global panel session */
  'session.start': ProjectRef & {
    worktreeId: string | null
    title?: string
    llm?: LlmSelection
    sessionTypeId?: string
    initialMessage?: string
    cols: number
    rows: number
  }
  'session.restart': SessionRef & { cols: number; rows: number }
  'session.close': SessionRef
  'session.rename': SessionRef & { title: string; expected?: string }
  /** Types the text into the session now */
  'session.sendPrompt': SessionRef & { text: string }
  /** Appends to the session's queue. Stored for a client to send; the server never sends it on its own */
  'session.enqueue': SessionRef & { text: string }
  'session.setQueue': SessionRef & { queue: string[] }
  /** Removes one queued prompt; `expected` is the prompt the client saw at `index` */
  'session.dequeue': SessionRef & { index: number; expected?: string }
  /** true = fully complete (tracking paused); false = resume tracking */
  'session.markComplete': SessionRef & { complete: boolean }
  /** A client showed the session to the user; clears attention/done for everyone */
  'session.seen': SessionRef
  /** Clears the session's open decision (the user dismissed it) for everyone */
  'session.dismissDecision': SessionRef
  // Terminal stream (same shapes as v1)
  'pty.attach': { ptyId: string }
  'pty.detach': { ptyId: string }
  'pty.write': { ptyId: string; data: string }
  'pty.resize': { ptyId: string; cols: number; rows: number }
  // Server repo registry
  /** Registers the git repo containing `path`; it must be under an allowed root */
  'server.addRepo': { path: string; name?: string }
  /** Fails with IN_USE while a project uses the repo */
  'server.removeRepo': { repoId: string }
  /** The agents the server can launch; with `projectId`, Claude's command is that project's `claudeCommand` when it has one */
  'server.agents': { projectId?: string }

  // Subscriptions
  'sub.subscribe': { topic: Topic }
  'sub.unsubscribe': { topic: Topic }
  // Misc
  'sys.ping': { t: number }
}

/** One agent CLI the server can run (`server.agents`). */
export interface AgentInfo {
  provider: LlmProviderId
  label: string
  /**
   * Whether the program of the command the server would run for it resolves in
   * the server user's login shell (checked at most once a minute per program)
   */
  installed: boolean
}

export interface ServerAgents {
  /** The server config's default agent, used when neither the session, its type nor the project picks one */
  llmDefault: LlmSelection
  /** Every provider the server knows, installed or not, in the server's order */
  agents: AgentInfo[]
}

export interface SubscribeResult<S> {
  snapshot: S
  rev: number
}

export interface MethodResultsV2 {
  'project.list': ProjectSummary[]
  'project.create': { projectId: string }
  'project.import': { projectId: string }
  'project.rename': null
  'project.delete': null
  'project.updateSettings': null
  'repo.add': { repoId: string }
  'repo.remove': null
  'repo.update': null
  'repo.listBranches': string[]
  'worktree.create': { worktreeId: string }
  'worktree.remove': null
  'worktree.load': null
  'worktree.unload': null
  'worktree.pull': null
  'worktree.push': null
  'worktree.changes': WorktreeChanges
  /** Patch text per changed file (same limits as v1 git.worktreeDiff) */
  'worktree.diff': Record<string, string>
  'branch.setTag': null
  'branch.setCustomTags': null
  'branch.setNote': null
  'branch.setTicket': null
  'branch.setPr': null
  'branch.setEnv': null
  'session.start': { sessionId: string; ptyId: string }
  'session.restart': { ptyId: string }
  'session.close': null
  'session.rename': null
  'session.sendPrompt': null
  'session.enqueue': null
  'session.setQueue': null
  'session.dequeue': null
  'session.markComplete': null
  'session.seen': null
  'session.dismissDecision': null
  'pty.attach': PtyInfo
  'pty.detach': null
  'pty.write': null
  'pty.resize': null
  /** The id of the new repo, or of the existing one if the path was already registered */
  'server.addRepo': { repoId: string }
  'server.removeRepo': null
  'server.agents': ServerAgents
  'sub.subscribe': SubscribeResult<ServerTopic | AttentionTopic | ProjectTopic>
  'sub.unsubscribe': null
  'sys.ping': { t: number }
}

export type MethodNameV2 = keyof MethodParamsV2

export type SubscribeResultFor<T extends Topic> = SubscribeResult<TopicSnapshot<T>>

type SameKeys<A, B> = [Exclude<keyof A, keyof B>, Exclude<keyof B, keyof A>] extends [never, never]
  ? true
  : false
/** Compile-time check: every method has both params and a result type. */
export const _catalogComplete: SameKeys<MethodParamsV2, MethodResultsV2> = true

/** A topic's rev, as a successful response reports it (PROTOCOL.md, "Revs"). */
export interface TopicRev {
  topic: Topic
  rev: number
}

/** A v2 response. A success may carry the rev its command left a topic at. */
export type ResFrameV2 =
  | { type: 'res'; id: number; ok: true; result: unknown; rev?: TopicRev }
  | { type: 'res'; id: number; ok: false; error: WireError }

export type ServerFrameV2 = WelcomeFrameV2 | ResFrameV2 | EventFrame

export interface StatePatchPayload extends StatePatch {
  topic: Topic
}

export interface EventPayloadsV2 {
  'pty.data': PtyDataEventWire
  'pty.exit': PtyExitEventWire
  'daemon.shutdown': { reason: string }
  'state.patch': StatePatchPayload
  /** Sent to a topic's subscribers just before it stops; nothing more comes for it */
  'topic.ended': TopicEndedPayload
}
