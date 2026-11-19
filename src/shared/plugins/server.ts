// The server half of a Trek plugin (plugin system phase 1): what trek-server hands it (the host)
// and what it gives back (its instance). A plugin's server code imports only this module, the
// shared types and its own folder; never server/src (scripts/pluginBoundaries.test.mjs).
import type { PluginManifest, PluginSettingValues } from './manifest.ts'
import type { TicketProvider } from './tickets.ts'
import type { ParsedPr, PromptHint, PrProvider, PrView } from './pullRequests.ts'
import type { TeardownItem, WorktreeOp } from '../teardown.ts'
export type { TeardownItem, WorktreeOp } from '../teardown.ts'

export { readBodyCapped, MAX_AUDIO_BYTES, MAX_ERROR_BYTES, MAX_JSON_BYTES } from '../../host/httpBody.ts'
export { writeFileAtomic } from '../../host/atomicWrite.ts'

/** Where a key lives (a name in the server's secrets file); it never leaves the server. */
export interface KeySlot {
  get(): string | null
  set(value: string | null): void
  setIfAbsent(value: string): boolean
}

/** A `setKey { ifAbsent }` that found a key already stored. */
export const PRESENT_ERROR = 'This server already has a key; it was kept'

/** The wire error codes a plugin may throw; anything else reaches the client as TOOL_ERROR. PATH_DENIED and GIT_ERROR (plugins E2): the host's checked lookups throw them. */
export type PluginErrorCode = 'BAD_REQUEST' | 'NOT_FOUND' | 'CONFLICT' | 'TOOL_ERROR' | 'NOT_SIGNED_IN' | 'PATH_DENIED' | 'GIT_ERROR'

/** What an error tells a client beside its code (plugins E2): `reason`, as core's own TOOL_ERRORs do (`missing`, `registry`). */
export interface PluginErrorDetails {
  reason?: string
}

/** An error that reaches the client with `code` (as the server's own codedError), and `details` when given. */
export function pluginError(code: PluginErrorCode, message: string, details?: PluginErrorDetails): Error {
  return Object.assign(new Error(message), { code }, details ? { details } : {})
}

const bad = (message: string): Error => pluginError('BAD_REQUEST', message)
const MAX_KEY = 1024

/** An API key: trimmed, not empty, printable, no whitespace inside (it goes into an HTTP header). */
export function requireApiKey(value: unknown): string {
  if (typeof value !== 'string') throw bad('apiKey must be a string')
  const key = value.trim()
  if (!key) throw bad('apiKey is required')
  if (key.length > MAX_KEY) throw bad(`apiKey must be at most ${MAX_KEY} characters`)
  if (!/^[\x21-\x7e]+$/.test(key)) throw bad('apiKey must be printable ASCII with no spaces')
  return key
}

/** An optional boolean parameter (false when absent). */
export function optionalFlag(value: unknown, field: string): boolean {
  if (value === undefined) return false
  if (typeof value !== 'boolean') throw bad(`${field} must be a boolean`)
  return value
}

export interface RunOptions {
  /** Default 30 s, at most 120 s */
  timeoutMs?: number
  /** stdout or stderr (each) past this fails the call; default 1 MiB, at most 16 MiB */
  maxBytes?: number
  signal?: AbortSignal
  /** Added to the program's env (the server's env plus these); PATH (in any case) is dropped, so it doesn't change how the program is found */
  env?: Record<string, string>
  /**
   * Where it runs (plugins E2), under `spawn`'s rule for `cwd` (a project's repository or present
   * worktree inside the server's allowed paths, or the plugin's data directory). Absent: the
   * server's own directory, as before.
   */
  cwd?: string
}

export interface SpawnOptions {
  /**
   * A repository's main checkout or one of its present worktrees, in one of the server's projects
   * and inside the server's allowed paths (PATH_DENIED otherwise, plugins E2), or the plugin's data
   * directory (dataFile's); anything else is refused
   */
  cwd: string
  /** Added to the server's env; PATH (in any case) is dropped, as for `run` */
  env?: Record<string, string>
  /** Kills the program when it aborts */
  signal?: AbortSignal
  /** Each chunk of its output as it comes (UTF-8); not with `detached`. A throw is logged once and the output keeps coming. */
  onOutput?(stream: 'stdout' | 'stderr', chunk: string): void
  /**
   * Outlives the plugin and the server (no stdio): keep its pid yourself (a data file) to end it
   * later. Default false: killed by the plugin's dispose.
   */
  detached?: boolean
  /**
   * Only for a built-in plugin (plugins E2: the Colima plugin's `colima start` and `docker compose
   * up -d`, which a server Stop, Restart or Update must not cut off). The plugin's dispose neither
   * signals it nor waits for it; its output still streams (onOutput) while the server runs. On POSIX
   * it leads its own process group, as every spawned program does, so a Ctrl-C at the server's
   * terminal doesn't reach it. `signal` and kill() still end it. Default false.
   */
  outlive?: boolean
}

export interface SpawnedProgram {
  pid: number
  /** How it ended: its exit code, or the signal that ended it (once it exits, though a grandchild keeps its output open) */
  done: Promise<{ code: number | null; signal: string | null }>
  /** POSIX: SIGTERM to its whole process group, SIGKILL 3 s later if it is still there. Windows: the program only. */
  kill(): void
}

/** A pull request host's server half (plugins P3): what the core's watch, `pr.resolve` and the MCP tools ask it. */
export interface PrServerProvider extends PrProvider {
  /** Signed in and usable now (gh: `gh auth status`); never rejects */
  available(signal?: AbortSignal): Promise<boolean>
  /** The pull request now. Rejects on any failure; with `code: 'NOT_SIGNED_IN'` when the sign-in is the problem */
  read(pr: ParsedPr, signal?: AbortSignal): Promise<PrView>
  /** The PR's head branch; null when it can't be told */
  headBranch(pr: ParsedPr, signal?: AbortSignal): Promise<string | null>
  /** The ref `git fetch origin` takes for PR `n`'s head ('refs/pull/12/head') */
  fetchRef(n: number): string
  /** How an agent reads a PR's checks and comments itself, for the watch's prompt; `{url}` is replaced with the PR's link */
  promptHint: PromptHint
}

/** A worktree as a plugin sees it (plugins E1): host.worktree(s) and the worktree lifecycle's hooks. Read only. */
export interface PluginWorktree {
  id: string
  repoId: string
  /** The repository's main checkout */
  repoPath: string
  path: string
  /** Null when detached */
  branch: string | null
  /** False once git no longer lists it (a `missing` row) */
  present: boolean
}

/** A repository as a plugin sees it (plugins E1). */
export interface PluginRepo {
  id: string
  path: string
  name: string
}

/**
 * A plugin's part in a worktree's teardown (plugins E1): before a remove, promote or move, the
 * server asks each set-up plugin for its items, whether the plugin is on in the project or not,
 * shows them in the client's confirm, and runs the chosen ones before the operation. Plugins E3: a
 * plugin switched off for a project still tears down what it made there, and still vetoes
 * (`beforeRepoRemove`).
 */
export interface WorktreeLifecycle {
  /**
   * What it would tear down (`id`: lowercase, digits, `.`, `_`, `-`; the server namespaces it as
   * `<plugin id>:<id>`). Left out of the plan when it throws or takes over 10 s.
   */
  plan(ctx: PluginCallContext, worktree: PluginWorktree, op: WorktreeOp): Promise<TeardownItem[]>
  /** Tears down the chosen items (its own ids, un-namespaced); a throw stops the operation, its message shown */
  teardown(ctx: PluginCallContext, worktree: PluginWorktree, op: WorktreeOp, ids: readonly string[]): Promise<void>
  /** Why the repository can't be removed from its project now; null (or undefined) when it can */
  beforeRepoRemove?(ctx: PluginCallContext, repo: PluginRepo): Promise<string | null | undefined>
}

export interface ServerPluginHost {
  readonly id: string
  /** A name its manifest lists in `secrets`; any other throws */
  secret(name: string): KeySlot
  /** `<dataDir>/plugins/<id>/<name>` (`name` one path segment, else it throws); the directory is made (0700) on first use */
  dataFile(name: string): string
  /**
   * `<dataDir>/<name>` (one path segment): only for a built-in plugin's one-time move of a file it
   * kept there before plugins (the voice plugin's voice.json). Not for installable plugins.
   */
  legacyDataFile(name: string): string
  /** A test endpoint from the server's environment (`envName`), taken only as http(s) on loopback */
  testEndpoint(envName: string): string | undefined
  /** Runs a program (a bare name on PATH, or an absolute path) with no shell; resolves with stdout, rejects with stderr's first line (`code: 'ENOENT'` when it is not installed). Aborted by the plugin's dispose. */
  run(command: string, args: readonly string[], options?: RunOptions): Promise<string>
  /**
   * Starts a program (plugins E1) under `run`'s rules (no shell; a bare name on PATH or an absolute
   * path; a Windows .js/.mjs stub through Node), with no timeout. Resolves once it has started;
   * rejects for a refused command or `cwd`, or `code: 'ENOENT'` when it is not installed.
   */
  spawn(command: string, args: readonly string[], options: SpawnOptions): Promise<SpawnedProgram>
  /** A test stub from the server's environment: `fallback` when `envName` is unset, its value when it is an absolute path, null otherwise (fail closed) */
  testCommand(envName: string, fallback: string): string | null
  /**
   * `<id>.<event>` to the project's subscribers (its open windows); the number reached. 0, sending
   * nothing, where the plugin is off for the project.
   */
  emit(projectId: string, event: string, data: unknown): number
  /**
   * `event` (its full name, which must start with `<id>.`) to one connection only (plugins E1),
   * through that connection's event sink: past its high-water mark a chunk is dropped and said so,
   * one with `done: true` never is. An unknown or closed caller is a no-op.
   *
   * Four payload fields carry the sink's meaning (any other payload, an object without them or not
   * an object at all, is an ordinary chunk: sent as given, or dropped while congested):
   * - `done: true`: the run's last event, never dropped.
   * - `step` (any value): a step, never dropped; a pending dropped notice waits for the next non-step event.
   * - `profile` (a string): with the event name, which run a chunk belongs to.
   * - `data`: the chunk's text, where the dropped notice puts its own.
   * After chunks were dropped, the run's next non-step event is preceded by one notice of the same event:
   * `{ data: '[output dropped: the connection fell behind]\n' }`, plus `profile` when the run has one.
   */
  emitTo(caller: string, event: string, payload: unknown): void
  /** The project's open windows: what `emit` could reach */
  subscriberCount(projectId: string): number
  /** On for the project (its `plugins` setting, or the manifest's default); false for a project that is not there */
  isEnabled(projectId: string): boolean
  /** Tells every connection the plugin's server-wide state changed (a key, its config): `plugins.changed { id }` */
  changed(): void
  /** The session `terminalId` names in the project; BAD_REQUEST without one, NOT_FOUND when there is none */
  session(projectId: string, terminalId: unknown): { sessionId: string; global: boolean }
  /** The project's worktrees, every repository's, in order (plugins E1); NOT_FOUND for a project that is not there */
  worktrees(projectId: string): PluginWorktree[]
  /** One of them; NOT_FOUND when there is none */
  worktree(projectId: string, worktreeId: string): PluginWorktree
  /** The project's repositories */
  repos(projectId: string): PluginRepo[]
  /** This plugin's settings for the repository (its manifest's `repoSettings`), a copy; {} when none are set */
  repoSettings(projectId: string, repoId: string): PluginSettingValues
  /** This plugin's settings for the branch (its manifest's `branchSettings`), a copy; {} when none are set */
  branchSettings(projectId: string, repoId: string, branch: string): PluginSettingValues
  /**
   * A repository a program may run in (plugins E2), checked as core's own machine methods check one:
   * in the project, still registered on this server, inside its allowed paths. Throws NOT_FOUND,
   * BAD_REQUEST or PATH_DENIED as those methods answer.
   */
  checkedRepo(projectId: unknown, repoId: unknown): PluginRepo
  /**
   * A worktree a program may run in (plugins E2), checked as core's own machine methods check one:
   * present (a `missing` row is BAD_REQUEST), its repository registered, inside the allowed paths
   * (PATH_DENIED). `refresh`: git's worktrees are re-read first (GIT_ERROR when git can't be read)
   * and the branch checked out now must be a branch name (BAD_REQUEST when detached).
   */
  checkedWorktree(projectId: unknown, worktreeId: unknown, options?: { refresh?: boolean }): Promise<PluginWorktree>
  /** The worktrees, in every project, the server is tearing down or holding for a remove, promote or move now (plugins E2), with the CONFLICT message for each */
  busyWorktrees(): { projectId: string; worktree: PluginWorktree; reason: string }[]
  /**
   * The same data file (`name`, one path segment) of the other Local profiles on this machine
   * (plugins E2), to read, never write: each one's `<its dataDir>/plugins/<id>/<name>` where it has
   * one, else its `<its dataDir>/<name>` from before plugins. [] on a server that is not Local.
   * Only for a built-in plugin's files from before plugins (the Colima registry).
   */
  legacySiblingDataFiles(name: string): string[]
  /**
   * `<app data dir>/<name>` on a Local server started with `--import-env-from <app data dir>`
   * (plugins E2): a file the app kept before 5a, for a built-in plugin's one-time take-over.
   * Undefined otherwise.
   */
  legacyImportFile(name: string): string | undefined
  readonly log: { info(message: string): void; warn(message: string): void }
}

export interface PluginCallContext {
  /** The request's `projectId`, when it names one */
  projectId?: string
  /**
   * The connection that sent the request (plugins E1): opaque, one per connection, never on the
   * wire; '' for a call from no connection (an MCP tool, an automation). `host.emitTo`'s address.
   */
  caller: string
}

export type PluginHandler = (params: Record<string, unknown>, ctx: PluginCallContext) => unknown

export interface PluginToolDefinition {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export interface PluginMcpTool {
  definition: PluginToolDefinition
  /** Runs in a project where the plugin is on; a throw is the tool's error result */
  call(args: Record<string, unknown>, ctx: { projectId: string; signal?: AbortSignal }): unknown
}

export interface PluginInstance {
  /** `<id>.<name>` on the wire; they answer whatever a project's enablement (setup is per server) */
  handlers: Record<string, PluginHandler>
  /** Listed and callable only in the projects where the plugin is on */
  mcpTools?: PluginMcpTool[]
  /** Appended to the trek-dev MCP instructions in those projects */
  mcpInstructions?: string
  /** Added to the launch prompt of an agent session with the MCP tools, in those projects */
  sessionPrompt?(projectId: string): string | undefined
  /** A ticket tracker (phase 2): `set_worktree_ticket` parses through it in the projects where the plugin is on */
  ticketProvider?: TicketProvider
  /** A pull request host (plugins P3): the watch, `pr.resolve` and the PR tools go through it in the projects where the plugin is on */
  prProvider?: PrServerProvider
  /**
   * Its part in a worktree's teardown (plugins E1). It takes part in every project, on or off there
   * (plugins E3), so keep `plan` and `beforeRepoRemove` cheap where the plugin has made nothing.
   */
  worktreeLifecycle?: WorktreeLifecycle
  /** A value for one of the manifest's `projectSettings` keys (already the declared kind): its problem, or null */
  checkProjectSetting?(key: string, value: string): string | null
  dispose?(): void
}

export interface ServerPlugin {
  manifest: PluginManifest
  setup(host: ServerPluginHost): PluginInstance
}

/** Types a plugin's server half. */
export const defineServerPlugin = (plugin: ServerPlugin): ServerPlugin => plugin
