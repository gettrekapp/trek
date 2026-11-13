// The server half of a Trek plugin (plugin system phase 1): what trek-server hands it (the host)
// and what it gives back (its instance). A plugin's server code imports only this module, the
// shared types and its own folder; never server/src (scripts/pluginBoundaries.test.mjs).
import type { PluginManifest } from './manifest.ts'

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
export type PluginErrorCode = 'BAD_REQUEST' | 'NOT_FOUND' | 'CONFLICT' | 'TOOL_ERROR'

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

export interface ServerPluginHost {
  readonly id: string
  /** A name its manifest lists in `secrets`; any other throws */
  secret(name: string): KeySlot
  /** `<dataDir>/plugins/<id>/<name>`; the directory is made (0700) on first use */
  dataFile(name: string): string
  /** The server's data dir itself, for a one-time move of a file the plugin had before it was one */
  legacyDataFile(name: string): string
  /** A test endpoint from the server's environment (`envName`), taken only as http(s) on loopback */
  testEndpoint(envName: string): string | undefined
  /**
   * `<id>.<event>` to the project's subscribers (its open windows); the number reached. 0, sending
   * nothing, where the plugin is off for the project.
   */
  emit(projectId: string, event: string, data: unknown): number
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
  dispose?(): void
}

export interface ServerPlugin {
  manifest: PluginManifest
  setup(host: ServerPluginHost): PluginInstance
}

/** Types a plugin's server half. */
export const defineServerPlugin = (plugin: ServerPlugin): ServerPlugin => plugin
