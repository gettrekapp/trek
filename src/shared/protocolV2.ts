// Protocol v2: the server owns all project state. Clients send domain commands
// and subscribe to topics (snapshot + JSON patches). Frames are the v1 frames
// (hello/req/res/event) from protocol.ts; only welcome, the method catalog and
// the events change. See PROTOCOL.md, "Protocol v2".
import type {
  AttentionTopic,
  ProjectTopic,
  ServerTopic,
  Topic,
  TopicSnapshot
} from './model/topics.ts'
import type { ProjectSettings, ProjectSummary, Project } from './model/types.ts'
import type {
  EventFrame,
  EventPayloads as EventPayloadsV1,
  PtyInfo,
  ResFrame
} from './protocol.ts'
import type { LlmSelection } from './providers/types.ts'
import type { StatePatch } from './sync/topicState.ts'
import type { EnvironmentSettings, WorktreeChanges } from './types.ts'

export const PROTOCOL_VERSION_V2 = 2

/** Versions a v2-capable server accepts in `hello`. */
export const SUPPORTED_PROTOCOL_VERSIONS: readonly number[] = [1, 2]

/** Close reason sent with code 4002 when the client is older than the server allows. */
export const CLOSE_REASON_UPGRADE_CLIENT = 'UPGRADE_CLIENT'

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
  'branch.setEnv': BranchRef & { env: string | null }
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
  /** true = fully complete (tracking paused); false = resume tracking */
  'session.markComplete': SessionRef & { complete: boolean }
  /** A client showed the session to the user; clears attention/done for everyone */
  'session.seen': SessionRef
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

  // Subscriptions
  'sub.subscribe': { topic: Topic }
  'sub.unsubscribe': { topic: Topic }
  // Misc
  'sys.ping': { t: number }
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
  'session.markComplete': null
  'session.seen': null
  'pty.attach': PtyInfo
  'pty.detach': null
  'pty.write': null
  'pty.resize': null
  /** The id of the new repo, or of the existing one if the path was already registered */
  'server.addRepo': { repoId: string }
  'server.removeRepo': null
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

export type ServerFrameV2 = WelcomeFrameV2 | ResFrame | EventFrame

export interface StatePatchPayload extends StatePatch {
  topic: Topic
}

export interface EventPayloadsV2 {
  'pty.data': EventPayloadsV1['pty.data']
  'pty.exit': EventPayloadsV1['pty.exit']
  'daemon.shutdown': EventPayloadsV1['daemon.shutdown']
  'state.patch': StatePatchPayload
}
