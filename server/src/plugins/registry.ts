// The server's plugins (plugin system phase 1): each built-in plugin's server half, set up once
// with its host (secrets, data files, its project's subscribers, the session lookup), then asked
// for its methods (`<id>.*` when no core method has the name), its MCP tools, instructions and
// session prompt in the projects where it is on.
import { chmodSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { projectTopic } from '../../../src/shared/model/topics.ts'
import { PLUGIN_ID_RE, pluginEnabled, type PluginManifest, type PluginPresence } from '../../../src/shared/plugins/manifest.ts'
import type { PluginHandler, PluginInstance, PluginMcpTool, ServerPlugin, ServerPluginHost } from '../../../src/shared/plugins/server.ts'
import { codedError } from '../errors.ts'
import { keySlot, testEndpoint } from '../integrations/integrations.ts'
import type { ProjectState } from '../projects/state.ts'
import { createSecretFile } from '../secrets.ts'
import { findSession } from '../sessions/locate.ts'
import type { TopicHub } from '../topicHub'

/** Namespaces a plugin may not take, beside those of the core methods. */
const RESERVED_IDS: ReadonlySet<string> = new Set(['plugins', 'integrations', 'sys', 'sub', 'mcp'])

/** A data file's name: one path segment, not `.` or `..` (a plugin keeps to its own directory). */
function checkFileName(name: string): string {
  if (!name || name === '.' || name === '..' || /[\\/\0]/.test(name)) throw new Error(`not a data file name: ${JSON.stringify(name)}`)
  return name
}

/** The error codes a plugin's method or tool may throw as they are; anything else is TOOL_ERROR. */
const PASSTHROUGH: ReadonlySet<string> = new Set(['BAD_REQUEST', 'NOT_FOUND', 'CONFLICT', 'TOOL_ERROR'])

export interface PluginRegistryOptions {
  plugins: readonly ServerPlugin[]
  /** The server's `secrets.json` */
  secretsFile: string
  /** The server's data dir: plugins' files go in `plugins/<id>/` there */
  dataDir: string
  hub: Pick<TopicHub, 'emit' | 'eventSubscriberCount'>
  projects: Pick<ProjectState, 'require'>
  /** Whether a core method has this name (a plugin can't take a core method's namespace) */
  isCoreMethod: (prefix: string) => boolean
  /** The core MCP tools' names (a plugin's tool can't shadow one) */
  coreToolNames: readonly string[]
  env?: NodeJS.ProcessEnv
  warn?: (message: string) => void
}

export interface PluginRegistry {
  /** The welcome's `plugins` */
  presence(): PluginPresence[]
  /** Each plugin's `legacyCapability`, for the welcome's `capabilities` */
  legacyCapabilities(): string[]
  /** The plugin method this name calls, if a plugin has it */
  handler(method: string): ((params: unknown) => Promise<unknown>) | undefined
  enabled(projectId: string, id: string): boolean
  /** The MCP tools of the plugins on in the project */
  tools(projectId: string): PluginMcpTool[]
  /** Their MCP instructions, joined (empty when none) */
  instructions(projectId: string): string
  /** Their session prompts, joined; undefined when none */
  sessionPrompt(projectId: string): string | undefined
  /** Called when a plugin says its server-wide state changed (`host.changed()`) */
  onChanged(listener: (manifest: PluginManifest) => void): void
  dispose(): void
}

interface Entry {
  manifest: PluginManifest
  instance: PluginInstance
}

/** A plugin's throw as the wire should see it: its own code if allowed, else TOOL_ERROR. */
function wireError(err: unknown): Error {
  const code = (err as { code?: unknown } | null)?.code
  if (typeof code === 'string' && PASSTHROUGH.has(code)) return err as Error
  return codedError('TOOL_ERROR', err instanceof Error ? err.message : String(err))
}

export function createPluginRegistry(options: PluginRegistryOptions): PluginRegistry {
  const warn = options.warn ?? ((message: string) => console.warn(message))
  const env = options.env ?? process.env
  const secrets = createSecretFile(options.secretsFile)
  const entries = new Map<string, Entry>()
  const changedListeners: ((manifest: PluginManifest) => void)[] = []
  const coreTools = new Set(options.coreToolNames)
  const toolOwners = new Map<string, string>()

  const enabled = (projectId: string, id: string): boolean => {
    const entry = entries.get(id)
    if (!entry) return false
    let settings
    try {
      settings = options.projects.require(projectId).settings
    } catch {
      return false
    }
    return pluginEnabled(settings.plugins, entry.manifest)
  }

  const hostFor = (manifest: PluginManifest): ServerPluginHost => {
    const dir = join(options.dataDir, 'plugins', manifest.id)
    const allowedSecrets = new Set(manifest.secrets ?? [])
    return {
      id: manifest.id,
      secret: (name) => {
        if (!allowedSecrets.has(name)) throw new Error(`plugin ${manifest.id} has no secret named ${name} in its manifest`)
        return keySlot(secrets, name)
      },
      dataFile: (name) => {
        mkdirSync(dir, { recursive: true, mode: 0o700 })
        chmodSync(dir, 0o700)
        return join(dir, checkFileName(name))
      },
      legacyDataFile: (name) => join(options.dataDir, checkFileName(name)),
      testEndpoint: (envName) => testEndpoint(envName, env[envName], warn),
      emit: (projectId, event, data) => (enabled(projectId, manifest.id) ? options.hub.emit(projectTopic(projectId), `${manifest.id}.${event}`, data) : 0),
      subscriberCount: (projectId) => options.hub.eventSubscriberCount(projectTopic(projectId)),
      isEnabled: (projectId) => enabled(projectId, manifest.id),
      changed: () => {
        for (const listener of changedListeners) listener(manifest)
      },
      session: (projectId, terminalId) => {
        if (typeof terminalId !== 'string' || !terminalId) throw codedError('BAD_REQUEST', 'terminalId is required')
        const found = findSession(options.projects.require(projectId), terminalId)
        return { sessionId: found.session.id, global: !found.worktree }
      },
      log: {
        info: (message) => console.log(`[plugin ${manifest.id}] ${message}`),
        warn: (message) => warn(`[plugin ${manifest.id}] ${message}`)
      }
    }
  }

  for (const plugin of options.plugins) {
    const { manifest } = plugin
    const refuse = (why: string): void => warn(`[plugins] ${manifest.id || '(no id)'} not loaded: ${why}`)
    if (!PLUGIN_ID_RE.test(manifest.id)) {
      refuse('its id is not a plugin id')
      continue
    }
    if (entries.has(manifest.id)) {
      refuse('another plugin has that id')
      continue
    }
    if (RESERVED_IDS.has(manifest.id) || options.isCoreMethod(`${manifest.id}.`)) {
      refuse('its id is a core namespace')
      continue
    }
    let instance: PluginInstance
    try {
      instance = plugin.setup(hostFor(manifest))
    } catch (err) {
      refuse(`its setup failed: ${err instanceof Error ? err.message : String(err)}`)
      continue
    }
    const clash = (instance.mcpTools ?? []).map((t) => t.definition.name).find((name) => coreTools.has(name) || toolOwners.has(name))
    if (clash) {
      refuse(`its MCP tool ${clash} has the name of another tool`)
      instance.dispose?.()
      continue
    }
    for (const tool of instance.mcpTools ?? []) toolOwners.set(tool.definition.name, manifest.id)
    entries.set(manifest.id, { manifest, instance })
  }

  const on = (projectId: string): Entry[] => [...entries.values()].filter((e) => enabled(projectId, e.manifest.id))

  return {
    presence: () => [...entries.values()].map((e) => ({ id: e.manifest.id, version: e.manifest.version, defaultEnabled: e.manifest.defaultEnabled })),
    legacyCapabilities: () => [...entries.values()].flatMap((e) => (e.manifest.legacyCapability ? [e.manifest.legacyCapability] : [])),
    handler: (method) => {
      const dot = method.indexOf('.')
      if (dot <= 0) return undefined
      const entry = entries.get(method.slice(0, dot))
      const name = method.slice(dot + 1)
      const handler: PluginHandler | undefined = entry && Object.hasOwn(entry.instance.handlers, name) ? entry.instance.handlers[name] : undefined
      if (!handler) return undefined
      return async (params) => {
        const p = params && typeof params === 'object' && !Array.isArray(params) ? (params as Record<string, unknown>) : {}
        try {
          return await handler(p, typeof p.projectId === 'string' ? { projectId: p.projectId } : {})
        } catch (err) {
          throw wireError(err)
        }
      }
    },
    enabled,
    tools: (projectId) =>
      on(projectId).flatMap((e) =>
        (e.instance.mcpTools ?? []).map((tool) => ({
          definition: tool.definition,
          call: async (args, ctx) => {
            try {
              return await tool.call(args, ctx)
            } catch (err) {
              throw wireError(err)
            }
          }
        }))
      ),
    instructions: (projectId) =>
      on(projectId)
        .map((e) => e.instance.mcpInstructions?.trim())
        .filter(Boolean)
        .join(' '),
    sessionPrompt: (projectId) => {
      const prompts = on(projectId).flatMap((e) => {
        try {
          const prompt = e.instance.sessionPrompt?.(projectId)?.trim()
          return prompt ? [prompt] : []
        } catch (err) {
          warn(`[plugin ${e.manifest.id}] its session prompt failed: ${err instanceof Error ? err.message : String(err)}`)
          return []
        }
      })
      return prompts.length > 0 ? prompts.join('\n\n') : undefined
    },
    onChanged: (listener) => {
      changedListeners.push(listener)
    },
    dispose: () => {
      // Each plugin once: after it the registry is empty, and a second dispose does nothing.
      const disposing = [...entries.values()]
      entries.clear()
      changedListeners.length = 0
      for (const e of disposing) {
        try {
          e.instance.dispose?.()
        } catch (err) {
          warn(`[plugin ${e.manifest.id}] dispose failed: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
    }
  }
}
