// The server half of a Trek plugin (plugin system phase 1): what trek-server hands it (the host)
// and what it gives back (its instance). A plugin's server code imports only this module, the
// shared types and its own folder; never server/src (scripts/pluginBoundaries.test.mjs).
import type { PluginManifest } from './manifest.ts'
import type { TicketProvider } from './tickets.ts'
import type { ParsedPr, PromptHint, PrProvider, PrView } from './pullRequests.ts'

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

/** The wire error codes a plugin may throw; anything else reaches the client as TOOL_ERROR. */
export type PluginErrorCode = 'BAD_REQUEST' | 'NOT_FOUND' | 'CONFLICT' | 'TOOL_ERROR' | 'NOT_SIGNED_IN'

/** An error that reaches the client with `code` (as the server's own codedError). */
export function pluginError(code: PluginErrorCode, message: string): Error {
  return Object.assign(new Error(message), { code })
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
}

export interface SpawnOptions {
  /**
   * A repository's main checkout or one of its present worktrees, in one of the server's projects,
   * or the plugin's data directory (dataFile's); anything else is refused
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
