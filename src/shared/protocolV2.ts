// Protocol v2, the wire protocol between clients (the desktop app, a future mobile app) and
// trek-server: JSON text frames over WebSocket. The server owns all project state; clients send
// domain commands and subscribe to topics (snapshot + JSON patches). See PROTOCOL.md. This file is
// the single source of truth for frame shapes. (Protocol v1, the per-call git and pty methods of
// the file windows, was retired in phase 4e: a v1 hello is refused with UPGRADE_CLIENT.)
import type { MoveBranchData, MoveCandidate, MoveExport, MoveHistoryChunk, MovePlan, MoveReceived, MoveSession } from './move.ts'
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
import type { PromotePlan, PromoteRequestEvent, PromoteResult, PromoteSettledEvent } from './promote.ts'
import type {
  ComposeAction,
  ContainerAction,
  ContainerInfo,
  DockerLogEvent,
  EnvCheckResult,
  EnvLogEvent,
  EnvService,
  EnvUpResult,
  EnvironmentInfo,
  EnvironmentSettings,
  LinearIssue,
  SkillInfo,
  LinearKeyResult,
  StackLogChunk,
  VoiceInfo,
  VoiceKeyResult,
  VoiceServerConfig,
  VoiceServerSettings,
  StackStatus,
  ChangesSource,
  CommitInfo,
  WorktreeChanges
} from './types.ts'

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
  /**
   * A docker, colima or stack.sh command on the server's machine failed. `details.reason`
   * `missing`: the tool is not on the server's PATH (not installed there); `registry`: the
   * server's environments registry cannot be read (env.list only: env.up and env.destroy resolve -1 instead; nothing written).
   */
  | 'TOOL_ERROR'

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
   * `missing`: a TOOL_ERROR's tool is not installed on the server.
   * `registry`: a TOOL_ERROR's environments registry cannot be read on the server.
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
  local: 'local',
  /** `docker.list`, `docker.container` and `docker.compose` run docker on the server's machine */
  docker: 'docker',
  /** `env.*` run the per-worktree Colima environments on the server's machine, and `env.log` streams their output */
  env: 'env',
  /** `stack.*` run the worktrees' docker/stack/stack.sh dev stacks on the server's machine */
  stacks: 'stacks',
  /** `linear.*` look up Linear issues with the server's own API key (set from any client, never read back) */
  linear: 'linear',
  /**
   * `voice.*` keep the server's ElevenLabs key and voice; its speak_summary tool sends each spoken
   * summary to the project's subscribers as `voice.summary`
   */
  voice: 'voice',
  /** `skills.list` lists a worktree's Claude Code skills and commands on the server's disk */
  skills: 'skills',
  /**
   * gh is installed and signed in on the server's machine, so `branch.setPrWatch` can turn a branch's
   * pull request watch on (5c-1). Checked at start, every ~10 minutes after that (listed or not), and
   * after a poll fails like a sign-in error; a change is pushed to every authenticated connection as
   * `integrations.changed` `{prWatch}`, which the client SDK applies to `welcome.capabilities`.
   */
  prWatch: 'prWatch',
  /**
   * The Changes tab's review (5c-2): `worktree.changes` and `worktree.diff` take a `source`,
   * `worktree.commits` lists the newest commits, and `review.*` keep a worktree's draft line
   * comments and send them to one of its sessions as one queued prompt
   */
  review: 'review',
  /**
   * Moving a worktree between servers (5d): `move.prepare`, `move.export`, `move.history` and
   * `move.finish` on the source, `move.candidates`, `move.begin`, `move.upload`, `move.abort`,
   * `move.receive` and `move.unreceive` on the target; the app relays between them
   */
  move: 'move',
  /**
   * Promote to primary and its reverse (5e): `worktree.promote` and `worktree.demote` (each with
   * `dryRun`), and the trek-dev tool promote_to_primary's confirmation: `promote.request` to the
   * project's subscribers, answered by one window's `promote.answer`, then `promote.settled`
   */
  promote: 'promote'
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
  /** `source` (5c-2, capability `review`) defaults to the branch against its base */
  'worktree.changes': WorktreeRef & { source?: ChangesSource }
  'worktree.diff': WorktreeRef & {
    source?: ChangesSource
    /** Only these files' patches (5c-2, at most MAX_REVIEW_COMMENTS = 100, as a review comment names them); without it, every changed file */
    paths?: string[]
  }
  /** The newest 100 commits on the worktree's HEAD, newest first (5c-2) */
  'worktree.commits': WorktreeRef
  /** A fresh `git status --porcelain` of the worktree (the status poll's `dirty` may be up to 30 s old) */
  'worktree.dirty': WorktreeRef
  /**
   * 5e: a worktree's branch into the main checkout (which must be clean), its uncommitted work
   * carried, the worktree removed last; its Claude and Local sessions move and resume there.
   * `dryRun` answers the plan. One request: any failure before the removal puts everything back.
   */
  'worktree.promote': WorktreeRef & { dryRun?: boolean }
  /**
   * 5e ("Promote branch to worktree"): the main checkout's branch, and its uncommitted work, into a
   * new worktree at the default path; the main checkout goes back to the default branch.
   */
  'worktree.demote': RepoRef & { dryRun?: boolean }
  /** 5e: a window's answer to `promote.request` (the first one wins; `accepted` false if late) */
  'promote.answer': { projectId: string; requestId: string; outcome: 'declined' | 'promoted' | 'failed'; worktreeId?: string; error?: string }
  // Branch data (null clears)
  'branch.setTag': BranchRef & { tag: string | null }
  'branch.setCustomTags': BranchRef & { customTags: string[] | null }
  'branch.setNote': BranchRef & { note: string | null; expected?: string | null }
  'branch.setTicket': BranchRef & { ticket: string | null }
  'branch.setPr': BranchRef & { pr: string | null }
  /** Turns the branch's pull request watch on or off (5c-1); on needs `prWatch` and a linked github.com PR */
  'branch.setPrWatch': BranchRef & { watch: boolean }
  /** Clears the worktree's pull request notice */
  'prWatch.dismiss': WorktreeRef
  'branch.setEnv': BranchRef & { env: string | null; expected?: string | null }
  // The Changes tab's review (5c-2): the draft is the worktree's `review` in the project topic
  /** A new line comment; `lineText` is the line as shown, without the diff's +, - or space */
  'review.add': WorktreeRef & {
    source: ChangesSource
    path: string
    side: 'old' | 'new'
    line: number
    lineText: string
    body: string
  }
  /** `expected`: the body the edit started from (compare-and-set) */
  'review.edit': WorktreeRef & { commentId: string; body: string; expected?: string }
  'review.remove': WorktreeRef & { commentId: string }
  /** Discards the draft; `revision`: the draft the client showed (compare-and-set) */
  'review.clear': WorktreeRef & { revision: number }
  /**
   * Queues the draft on `sessionId` (one of the worktree's sessions) as one prompt and clears it, in
   * one change; `revision`: the draft the client showed, so nothing unseen is sent (CONFLICT)
   */
  'review.send': WorktreeRef & { sessionId: string; revision: number }
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
  // Terminal stream
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
  // Docker on the server's machine (capability `docker`)
  /** `docker ps -a` */
  'docker.list': Record<string, never>
  /** `id`: a container id or name, as `docker.list` gave it */
  'docker.container': { action: ContainerAction; id: string }
  /** `docker compose <action's args>` in the repository's main checkout; its output streams to this connection as `docker.log` */
  'docker.compose': RepoRef & { action: ComposeAction }
  // The worktrees' Colima environments on the server's machine (capability `env`)
  /** colima and docker on the server's PATH (an `ok` answer is kept) */
  'env.check': Record<string, never>
  /** The repository's environments (by its envRepoKey), and the twb- VMs no registry entry names */
  'env.list': RepoRef
  /**
   * Starts (or creates) the worktree's branch's VM and runs `docker compose up -d` in the worktree,
   * with `settings` (the repository's, with the compose file picked) and the branch's variables as
   * parsed `envVars`. Its output streams to this connection as `env.log`. Long: minutes on a first boot.
   */
  'env.up': WorktreeRef & { settings: EnvironmentSettings; envVars?: Record<string, string> }
  /** `profile`: a twb- profile name */
  'env.stop': { profile: string }
  /** Deletes the VM (and, if its worktree is still there, `compose down -v` first) and its registry entry */
  'env.destroy': { profile: string }
  'env.ps': WorktreeRef & { composeFile?: string }
  /** The compose files in the worktree's root */
  'env.composeFiles': WorktreeRef
  /** The last `tail` lines (default 300, at most 5000) of one compose service */
  'env.logs': WorktreeRef & { composeFile?: string; service: string; tail?: number }
  // The worktrees' dev stacks on the server's machine (capability `stacks`)
  'stack.status': WorktreeRef
  /** Starts `stack.sh up` (detached; it outlives the request and the server) */
  'stack.up': WorktreeRef & { starter: boolean }
  /** `stack.sh down`, after Ctrl-C'ing a running `up`; resolves its exit code */
  'stack.down': WorktreeRef
  /** `stack.sh destroy`, after Ctrl-C'ing a running `up`; resolves its exit code */
  'stack.destroy': WorktreeRef
  /** The stack's log from `offset` of the file `fileId` names, or its last 64 KiB when that file is gone */
  'stack.log': WorktreeRef & { fileId: number; offset: number }

  // Linear, with the server's API key (capability `linear`)
  /** Whether the server has a Linear key */
  'linear.status': Record<string, never>
  /**
   * Checks the key with Linear and stores it on the server (0600, never sent back). `ifAbsent` (the
   * app's hand-over): stored as it is, unchecked, only while the server has none; a stored key is
   * kept and the result says `present`.
   */
  'linear.setKey': { apiKey: string; ifAbsent?: boolean }
  'linear.clearKey': Record<string, never>
  /** The issues with these ids (e.g. TOW-123) that exist and the key can see; none without a key */
  'linear.issues': { ids: string[] }

  // ElevenLabs voice summaries, with the server's API key (capability `voice`)
  /** The server's voice, model and "Summarize automatically", and whether it has a key */
  'voice.settings': Record<string, never>
  /**
   * Checks the key by listing its voices and stores it on the server (0600, never sent back); picks
   * the first voice if none is chosen. `ifAbsent` as `linear.setKey`'s.
   */
  'voice.setKey': { apiKey: string; ifAbsent?: boolean }
  'voice.clearKey': Record<string, never>
  /** The key's voices */
  'voice.voices': Record<string, never>
  'voice.setConfig': Partial<VoiceServerConfig>
  /** An mp3 of `text` (at most 400 characters), for this connection only: Settings' Test */
  'voice.synthesize': { text: string }

  // Skills (capability `skills`)
  /** The worktree's `.claude/skills` and `.claude/commands`, then the server user's `~/.claude` ones */
  'skills.list': WorktreeRef

  // Moving a worktree between servers (capability `move`, 5d)
  /** Source, read only: what would move */
  'move.prepare': WorktreeRef
  /** Source: HEAD, the uncommitted work, the Claude histories and the branch data of an unloaded worktree */
  'move.export': WorktreeRef
  /** Source: one chunk of a carried session's history, from `offset` */
  'move.history': WorktreeRef & { agentSessionId: string; offset: number }
  /** Target: opens a transfer for one move's histories */
  'move.begin': RepoRef
  /** Target: appends a chunk (base64) to one history in the transfer, at `offset` (what is staged so far) */
  'move.upload': { transferId: string; agentSessionId: string; offset: number; data: string }
  /** Target: drops a transfer; an unknown one is fine */
  'move.abort': { transferId: string }
  /** Source: removes the worktree if it is unchanged since `move.export` (its `fingerprint`); else CONFLICT */
  'move.finish': WorktreeRef & { fingerprint: string; verifyOnly?: boolean }
  /** Target: where a branch of a repository with this origin can go, in every project */
  'move.candidates': { origin: string; branch: string }
  /** Target: builds the worktree from origin and the export, or undoes all of it */
  'move.receive': RepoRef & { branch: string; head: string; patch: string; sessions: MoveSession[]; branchData: MoveBranchData; transferId?: string }
  /** Target: undoes a `move.receive` whole (its `undoToken`): the worktree, the branch it made, the branch data, the PR watch, the histories */
  'move.unreceive': RepoRef & { undoToken: string }

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
  /** Patch text per changed file (gitService's limits: no entry for binary or too-large files, 8 MiB in all) */
  'worktree.diff': Record<string, string>
  /** null when git cannot read the worktree's status */
  'worktree.dirty': boolean | null
  'worktree.promote': PromotePlan | PromoteResult
  'worktree.demote': PromotePlan | PromoteResult
  'promote.answer': { accepted: boolean }
  'worktree.commits': CommitInfo[]
  'branch.setTag': null
  'branch.setCustomTags': null
  'branch.setNote': null
  'branch.setTicket': null
  'branch.setPr': null
  'branch.setPrWatch': null
  'prWatch.dismiss': null
  'branch.setEnv': null
  'review.add': { commentId: string }
  'review.edit': null
  'review.remove': null
  'review.clear': null
  'review.send': null
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
  'docker.list': ContainerInfo[]
  'docker.container': null
  /** docker compose's exit code; -1 when docker could not run */
  'docker.compose': number
  'env.check': EnvCheckResult
  'env.list': EnvironmentInfo[]
  'env.up': EnvUpResult
  /** colima's exit code */
  'env.stop': number
  'env.destroy': number
  'env.ps': EnvService[]
  'env.composeFiles': string[]
  'env.logs': string
  'stack.status': StackStatus
  'stack.up': null
  'stack.down': number
  'stack.destroy': number
  'stack.log': StackLogChunk
  'linear.status': { hasKey: boolean }
  'linear.setKey': LinearKeyResult
  'linear.clearKey': null
  'linear.issues': LinearIssue[]
  'voice.settings': VoiceServerSettings
  'voice.setKey': VoiceKeyResult
  'voice.clearKey': null
  'voice.voices': VoiceInfo[]
  'voice.setConfig': VoiceServerConfig
  /** The mp3, base64 */
  'voice.synthesize': { audio: string }
  'skills.list': SkillInfo[]
  'move.prepare': MovePlan
  'move.export': MoveExport & { fingerprint: string }
  'move.history': MoveHistoryChunk
  'move.begin': { transferId: string }
  'move.upload': { size: number }
  'move.abort': null
  'move.finish': null
  'move.candidates': MoveCandidate[]
  'move.receive': MoveReceived
  'move.unreceive': null
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
  /** A `docker.compose` run's output, to the connection that asked for it only */
  'docker.log': DockerLogEvent
  /** An `env.up`, `env.stop` or `env.destroy`'s output and steps, to the connection that asked for it only */
  'env.log': EnvLogEvent
  /**
   * A session's spoken summary (the speak_summary tool), to every connection subscribed to its
   * project's topic; a client plays it unless its user is Busy
   */
  'voice.summary': VoiceSummaryEvent
  /**
   * The server's Linear or ElevenLabs key or voice settings changed (any client's linear.setKey
   * that stored, linear.clearKey, voice.setKey that stored, voice.clearKey, voice.setConfig), to
   * every authenticated connection: re-read `linear.status` / `voice.settings`
   */
  'integrations.changed': IntegrationsChangedEvent
  /** 5e: promote_to_primary asks the project's subscribers to confirm; one answers with `promote.answer` */
  'promote.request': PromoteRequestEvent
  /** 5e: the request was answered (or ended): close its dialog */
  'promote.settled': PromoteSettledEvent
}

export interface IntegrationsChangedEvent {
  linear?: true
  voice?: true
  /**
   * gh's sign-in on the server's machine changed (5c-1): the `prWatch` capability is now listed
   * (true) or not (false). The client SDK applies it to `welcome.capabilities`.
   */
  prWatch?: boolean
}

export interface VoiceSummaryEvent {
  projectId: string
  /** The session that spoke (its terminalId) */
  sessionId: string
  text: string
  /** The mp3, base64 */
  audio: string
}
