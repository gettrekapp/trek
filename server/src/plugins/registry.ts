// The server's plugins (plugin system phase 1): each built-in plugin's server half, set up once
// with its host (secrets, data files, its programs (run, spawn), its project's subscribers, the
// session lookup), then asked for its methods (`<id>.*` when no core method has the name), its MCP
// tools, instructions and session prompt in the projects where it is on.
import { chmodSync, lstatSync, mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { isInside } from '../../../src/host/pathContainment.ts'
import { projectTopic } from '../../../src/shared/model/topics.ts'
import type { Repository, Worktree } from '../../../src/shared/model/types'
import {
  legacyCapabilitiesOf,
  isUsablePluginId,
  pluginEnabled,
  pluginFieldsProblem,
  type PluginFieldKind,
  type PluginManifest,
  type PluginPresence,
  type PluginSettingValues
} from '../../../src/shared/plugins/manifest.ts'
import { agentProblem, type AgentProvider } from '../../../src/shared/plugins/agents.ts'
import type { PluginHandler, PluginInstance, PluginMcpTool, PrServerProvider, ServerPlugin, ServerPluginHost, WorktreeLifecycle } from '../../../src/shared/plugins/server.ts'
import type { TicketProvider } from '../../../src/shared/plugins/tickets.ts'
import { isCoreSettingsKey, type PluginSettingRules } from '../projects/settings.ts'
import { repoIn } from '../projects/model.ts'
import { codedError } from '../errors.ts'
import type { WireErrorCode } from '../../../src/shared/protocolV2.ts'
import { keySlot, testEndpoint } from '../integrations/integrations.ts'
import type { ProjectState } from '../projects/state.ts'
import { createSecretFile } from '../secrets.ts'
import { findSession } from '../sessions/locate.ts'
import { commandFromEnv, runCommand, spawnCommand, SPAWN_KILL_GRACE_MS } from './run.ts'
import { realOrResolved } from '../repos.ts'
import { pluginRepo, pluginWorktree } from './worktrees.ts'
import { anyBusy, busyReason } from '../teardown/teardown.ts'
import type { TopicHub } from '../topicHub'

/**
 * Namespaces a plugin may not take, beside those of the core methods: among them the core events
 * whose namespace is no method's (`state.patch`, `topic.ended`, `daemon.shutdown`, `integrations.changed`).
 */
export const RESERVED_IDS: ReadonlySet<string> = new Set(['plugins', 'integrations', 'sys', 'sub', 'mcp', 'pr', 'state', 'topic', 'daemon'])

/**
 * A data file's name: one path segment, not `.` or `..` (a plugin keeps to its own directory), and
 * no `:` (on Windows, `name:stream` is an NTFS alternate data stream and `C:name` a drive-relative path).
 */
function checkFileName(name: string): string {
  if (!name || name === '.' || name === '..' || /[\\/:\0]/.test(name)) throw new Error(`not a data file name: ${JSON.stringify(name)}`)
  return name
}

/** `name` in `dir`, checked to stay inside it (isInside: either separator and case on Windows). */
function fileIn(dir: string, name: string): string {
  const path = join(dir, checkFileName(name))
  if (!isInside(dir, path, process.platform, true)) throw new Error(`not a data file name: ${JSON.stringify(name)}`)
  return path
}

/** The error codes a plugin's method or tool may throw as they are; anything else is TOOL_ERROR. PATH_DENIED and GIT_ERROR: the host's checked lookups (plugins E2). */
const PASSTHROUGH: ReadonlySet<string> = new Set(['BAD_REQUEST', 'NOT_FOUND', 'CONFLICT', 'TOOL_ERROR', 'NOT_SIGNED_IN', 'PATH_DENIED', 'GIT_ERROR'])

/** How long dispose waits for the plugins' children (plugins E2): past the SIGKILL that follows their SIGTERM. */
export const PLUGIN_STOP_MS = SPAWN_KILL_GRACE_MS + 500

/** Core's checks before a plugin runs a program somewhere (plugins E2; coreChecks.ts). */
export interface PluginPathChecks {
  /** Throws the server's own refusal (the path guard's PATH_DENIED, its wording and its UNC reason) when its allowlist does not cover the path */
  check(path: string): void
  /** The repository a machine method may use (in the project, registered, allowed); throws as core's methods do */
  repo(projectId: unknown, repoId: unknown): Repository
  /** The present worktree a machine method may use; `refresh`: git re-read and the branch name checked (checkedOut) */
  worktree(projectId: unknown, worktreeId: unknown, refresh: boolean): Promise<{ repo: Repository; worktree: Worktree }>
}

export interface PluginRegistryOptions {
  plugins: readonly ServerPlugin[]
  /** The server's `secrets.json` */
  secretsFile: string
  /** The server's data dir: plugins' files go in `plugins/<id>/` there */
  dataDir: string
  hub: Pick<TopicHub, 'emit' | 'eventSubscriberCount'>
  projects: Pick<ProjectState, 'require' | 'all'>
  /** Whether a core method has this name (a plugin can't take a core method's namespace) */
  isCoreMethod: (prefix: string) => boolean
  /** The core MCP tools' names (a plugin's tool can't shadow one) */
  coreToolNames: readonly string[]
  env?: NodeJS.ProcessEnv
  warn?: (message: string) => void
  /** For tests: the platform the `platforms` manifests are matched against (default: process.platform) */
  platform?: NodeJS.Platform
  /** Core's path checks (plugins E2): without them a program's cwd is checked against the projects only */
  paths?: PluginPathChecks
  /** A Local server's other Local profiles' data dirs (siblings.ts): host.legacySiblingDataFiles */
  siblingDataDirs?: () => string[]
  /** `start --local --import-env-from <dir>`: the app's data dir, for host.legacyImportFile */
  importFrom?: string
}

/** A plugin's worktree lifecycle, with the id its items are namespaced by (plugins E1). */
export interface PluginLifecycle {
  id: string
  lifecycle: WorktreeLifecycle
}

/** An agent a set-up plugin offers (plugins A1), with what core needs of its plugin. */
export interface PluginAgent {
  pluginId: string
  /** Its plugin's `projectSettings` keys: what AgentConfig.project holds */
  projectKeys: readonly string[]
  agent: AgentProvider
}

/** Why a plugin's agents can't be taken (plugins A1), or null. */
function agentsRefusal(manifest: PluginManifest, agents: unknown, owners: ReadonlyMap<string, string>, suffixes: ReadonlyMap<string, string>): string | null {
  if (agents === undefined) return null
  // A theme plugin (its manifest's type/contract marks say it is installable) has no server half, so it cannot offer agents.
  if (manifest.type !== undefined || manifest.contract !== undefined) return 'a theme plugin (type/contract) cannot offer agents'
  if (!Array.isArray(agents)) return 'its agentProviders must be a list'
  const ids = new Set<string>()
  /** This plugin's MCP file suffixes → the agent that writes each */
  const files = new Map<string, string>()
  for (const value of agents as unknown[]) {
    const problem = agentProblem(value)
    if (problem) {
      const id = (value as { id?: unknown } | null)?.id
      return `its agent ${typeof id === 'string' ? JSON.stringify(id) : '(no id)'} ${problem}`
    }
    const agent = value as AgentProvider
    if (owners.has(agent.id) || ids.has(agent.id)) return `its agent ${JSON.stringify(agent.id)} has the id of another agent`
    ids.add(agent.id)
    if (agent.mcpFile) {
      const owner = suffixes.get(agent.mcpFile.suffix) ?? files.get(agent.mcpFile.suffix)
      if (owner !== undefined) return `its agent ${JSON.stringify(agent.id)}'s MCP file ${JSON.stringify(agent.mcpFile.suffix)} is the agent ${JSON.stringify(owner)}'s`
      files.set(agent.mcpFile.suffix, agent.id)
    }
  }
  return null
}

export interface PluginRegistry {
  /** The welcome's `plugins` */
  presence(): PluginPresence[]
  /** Each plugin's `legacyCapability`, for the welcome's `capabilities` */
  legacyCapabilities(): string[]
  /** The plugin method this name calls, if a plugin has it */
  handler(method: string): ((params: unknown, caller?: string) => Promise<unknown>) | undefined
  /** A connection's sender for host.emitTo, under its caller id (plugins E1); returns the disconnect */
  connect(caller: string, send: (event: string, payload: unknown) => void): () => void
  enabled(projectId: string, id: string): boolean
  /** The MCP tools of the plugins on in the project */
  tools(projectId: string): PluginMcpTool[]
  /** Their MCP instructions, joined (empty when none) */
  instructions(projectId: string): string
  /** Their session prompts, joined; undefined when none */
  sessionPrompt(projectId: string): string | undefined
  /** The ticket providers of the plugins on in the project, in registration order (phase 2) */
  ticketProviders(projectId: string): TicketProvider[]
  /** The PR providers of the plugins on in the project, in registration order (plugins P3) */
  prProviders(projectId: string): PrServerProvider[]
  /** Every registered plugin's PR provider, on in a project or not: the watch checks their sign-ins */
  allPrProviders(): PrServerProvider[]
  /** Every set-up plugin's agents (plugins A1), in registration order; the agent registry sorts them */
  agentProviders(): PluginAgent[]
  /**
   * Every set-up plugin's worktree lifecycle, in registration order (plugins E1), on in the project
   * or not (plugins E3): a plugin switched off for a project still tears down what it made there,
   * and still keeps a repository whose VM runs in its project.
   */
  lifecycles(projectId: string): PluginLifecycle[]
  /** The project settings the registered plugins own (phase 2), whether or not they are on in a project */
  readonly settingRules: PluginSettingRules
  /** A registered plugin's `repoSettings` or `branchSettings` (plugins E1); undefined when it is not registered here or declares none */
  settingFields(pluginId: string, scope: 'repo' | 'branch'): Readonly<Record<string, PluginFieldKind>> | undefined
  /** Called when a plugin says its server-wide state changed (`host.changed()`) */
  onChanged(listener: (manifest: PluginManifest) => void): void
  /** Stops every plugin; resolves once their programs (host.run's, and host.spawn's but detached and outlive ones, each with its whole group) are gone or SIGKILLed, at most PLUGIN_STOP_MS later */
  dispose(): Promise<void>
}

interface Entry {
  manifest: PluginManifest
  instance: PluginInstance
}

/** A plugin's own entry in stored `pluginSettings`, as a copy; {} when it has none (an own key only: never Object's members). */
function ownValues(byId: Record<string, PluginSettingValues> | undefined, id: string): PluginSettingValues {
  return byId && Object.hasOwn(byId, id) ? { ...byId[id] } : {}
}

/**
 * A plugin's throw as the wire should see it: its own code if allowed, else TOOL_ERROR. Rebuilt, so
 * only a string `details.reason` comes along: `details.tornDown` is core's orchestrator's to say
 * (what a worktree's teardown ended), never a plugin's.
 */
function wireError(err: unknown): Error {
  const code = (err as { code?: unknown } | null)?.code
  const message = err instanceof Error ? err.message : String(err)
  if (typeof code !== 'string' || !PASSTHROUGH.has(code)) return codedError('TOOL_ERROR', message)
  const details = (err as { details?: unknown }).details
  const reason = details && typeof details === 'object' ? (details as { reason?: unknown }).reason : undefined
  return codedError(code as WireErrorCode, message, typeof reason === 'string' && reason ? { reason } : undefined)
}

/**
 * Whether anything (a file, a directory, a symlink, even a dangling one) is at the path: as the
 * Colima plugin's data.ts decides whose a registry is. Only ENOENT is nothing: a path that can't be
 * looked at (EACCES) may hold a file, so the stale old one beside it is not read instead.
 */
function present(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ENOENT'
  }
}

export function createPluginRegistry(options: PluginRegistryOptions): PluginRegistry {
  const warn = options.warn ?? ((message: string) => console.warn(message))
  const env = options.env ?? process.env
  const secrets = createSecretFile(options.secretsFile)
  const entries = new Map<string, Entry>()
  /** Registered plugins not for this server's platform (plugins E1): never set up, listed `available: false` */
  const unavailable: PluginManifest[] = []
  const platform = options.platform ?? process.platform
  const changedListeners: ((manifest: PluginManifest) => void)[] = []
  const coreTools = new Set(options.coreToolNames)
  const toolOwners = new Map<string, string>()
  /** A plugin project setting's key → the plugin that owns it */
  const settingOwners = new Map<string, string>()
  /** An agent's id → the plugin that offers it (plugins A1) */
  const agentOwners = new Map<string, string>()
  /** An MCP file suffix → the agent that writes it (plugins A1) */
  const mcpSuffixes = new Map<string, string>()
  /** Each plugin's abort for its running programs (host.run, host.spawn unless detached or outlive): fired by dispose */
  const aborts = new Map<string, AbortController>()
  /** Each open connection's sender, by its caller id (server.ts): what host.emitTo reaches */
  const callers = new Map<string, (event: string, payload: unknown) => void>()
  /** Each running program's `stopped` (host.run, host.spawn unless detached or outlive): dispose waits for them */
  const live = new Set<Promise<void>>()
  const track = (stopped: Promise<void>): void => {
    live.add(stopped)
    void stopped.then(() => live.delete(stopped))
  }

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
    const abort = new AbortController()
    aborts.set(manifest.id, abort)
    /**
     * A program's cwd (plugins E1, E2: host.spawn, and host.run when it has one): exactly a project's
     * repository or present worktree, inside the server's allowed paths, or this plugin's data directory.
     */
    const programCwd = (cwd: unknown): string => {
      if (typeof cwd !== 'string' || cwd === '') throw new Error("spawn needs a cwd: a repository, a worktree or the plugin's data directory")
      const key = realOrResolved(cwd)
      if (key === realOrResolved(dir)) {
        mkdirSync(dir, { recursive: true, mode: 0o700 })
        return dir
      }
      const usable = (path: string): string => {
        if (statSync(path, { throwIfNoEntry: false })?.isDirectory() !== true) throw new Error(`${cwd} does not exist`)
        options.paths?.check(path)
        return path
      }
      for (const project of options.projects.all()) {
        for (const repo of project.repositories) {
          if (realOrResolved(repo.path) === key) return usable(repo.path)
          const worktree = repo.worktrees.find((w) => w.missing !== true && realOrResolved(w.path) === key)
          if (worktree) return usable(worktree.path)
        }
      }
      throw new Error(`${cwd} is not a repository, a worktree or this plugin's data directory`)
    }
    const requirePaths = (): PluginPathChecks => {
      if (!options.paths) throw new Error('this server has no path checks for plugins')
      return options.paths
    }
    return {
      id: manifest.id,
      secret: (name) => {
        if (!allowedSecrets.has(name)) throw new Error(`plugin ${manifest.id} has no secret named ${name} in its manifest`)
        return keySlot(secrets, name)
      },
      dataFile: (name) => {
        mkdirSync(dir, { recursive: true, mode: 0o700 })
        chmodSync(dir, 0o700)
        return fileIn(dir, name)
      },
      legacyDataFile: (name) => fileIn(options.dataDir, name),
      testEndpoint: (envName) => testEndpoint(envName, env[envName], warn),
      // Only the known options: a plugin can't reach runCommand's or spawnCommand's test-only ones (platform).
      // async: a refused cwd is a rejection, as for spawn.
      run: async (command, args, opts = {}) =>
        runCommand(command, args, {
          timeoutMs: opts.timeoutMs,
          maxBytes: opts.maxBytes,
          env: opts.env,
          ...(opts.cwd !== undefined ? { cwd: programCwd(opts.cwd) } : {}),
          signal: opts.signal ? AbortSignal.any([opts.signal, abort.signal]) : abort.signal,
          onStopped: track
        }),
      spawn: async (command, args, opts) => {
        const cwd = programCwd(opts?.cwd)
        const detached = opts.detached === true
        // A detached or outlive child outlives the plugin: the dispose's abort is not its signal,
        // and the dispose doesn't wait for it.
        const outlives = detached || opts.outlive === true
        const signal = outlives ? opts.signal : opts.signal ? AbortSignal.any([opts.signal, abort.signal]) : abort.signal
        const { pid, done, stopped, kill } = await spawnCommand(command, args, {
          cwd,
          env: opts.env,
          signal,
          detached,
          onOutput: opts.onOutput,
          warn: (message) => warn(`[plugin ${manifest.id}] ${message}`)
        })
        if (!outlives) track(stopped)
        // stopped is the host's own: the plugin gets what SpawnedProgram names.
        return { pid, done, kill }
      },
      testCommand: (envName, fallback) => commandFromEnv(envName, env[envName], fallback, warn),
      emit: (projectId, event, data) => (enabled(projectId, manifest.id) ? options.hub.emit(projectTopic(projectId), `${manifest.id}.${event}`, data) : 0),
      // No check that the plugin is on in a project, unlike `emit`: the caller asked for this
      // operation while it was on, and its log runs to its end (its `done`) even if the plugin is
      // turned off meanwhile.
      emitTo: (caller, event, payload) => {
        if (!event.startsWith(`${manifest.id}.`) || event.length === manifest.id.length + 1) {
          throw new Error(`plugin ${manifest.id} sends only its own events (${manifest.id}.*), not ${JSON.stringify(event)}`)
        }
        callers.get(caller)?.(event, payload)
      },
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
      worktrees: (projectId) => options.projects.require(projectId).repositories.flatMap((r) => r.worktrees.map((w) => pluginWorktree(r, w))),
      worktree: (projectId, worktreeId) => {
        for (const repo of options.projects.require(projectId).repositories) {
          const found = repo.worktrees.find((w) => w.id === worktreeId)
          if (found) return pluginWorktree(repo, found)
        }
        throw codedError('NOT_FOUND', `No worktree with id "${worktreeId}" in this project`)
      },
      repos: (projectId) => options.projects.require(projectId).repositories.map(pluginRepo),
      repoSettings: (projectId, repoId) => ownValues(repoIn(options.projects.require(projectId), repoId).pluginSettings, manifest.id),
      branchSettings: (projectId, repoId, branch) => {
        const repo = repoIn(options.projects.require(projectId), repoId)
        const data = Object.hasOwn(repo.branchData, branch) ? repo.branchData[branch] : undefined
        return ownValues(data?.pluginSettings, manifest.id)
      },
      checkedRepo: (projectId, repoId) => pluginRepo(requirePaths().repo(projectId, repoId)),
      checkedWorktree: async (projectId, worktreeId, opts = {}) => {
        const { repo, worktree } = await requirePaths().worktree(projectId, worktreeId, opts.refresh === true)
        return pluginWorktree(repo, worktree)
      },
      // Nothing held (almost always): no walk over every project's worktrees.
      busyWorktrees: () => {
        if (!anyBusy()) return []
        return [...options.projects.all()].flatMap((project) =>
          project.repositories.flatMap((repo) =>
            repo.worktrees.flatMap((worktree) => {
              const reason = busyReason(worktree.path)
              return reason ? [{ projectId: project.id, worktree: pluginWorktree(repo, worktree), reason }] : []
            })
          )
        )
      },
      legacySiblingDataFiles: (name) => {
        checkFileName(name)
        return (options.siblingDataDirs?.() ?? []).map((sibling) => {
          const own = fileIn(join(sibling, 'plugins', manifest.id), name)
          return present(own) ? own : fileIn(sibling, name)
        })
      },
      legacyImportFile: (name) => {
        checkFileName(name)
        return options.importFrom === undefined ? undefined : fileIn(options.importFrom, name)
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
    if (!isUsablePluginId(manifest.id)) {
      refuse('its id is not a usable plugin id')
      continue
    }
    if (entries.has(manifest.id) || unavailable.some((m) => m.id === manifest.id)) {
      refuse('another plugin has that id')
      continue
    }
    if (RESERVED_IDS.has(manifest.id) || options.isCoreMethod(`${manifest.id}.`)) {
      refuse('its id is a core namespace')
      continue
    }
    const declared = manifest.projectSettings ?? {}
    const keys = Object.keys(declared)
    if (keys.some((key) => !key)) {
      refuse('it declares a project setting with an empty key')
      continue
    }
    const badKind = keys.find((key) => (declared as Record<string, unknown>)[key] !== 'string')
    if (badKind !== undefined) {
      refuse(`its project setting ${badKind} is of a kind other than 'string'`)
      continue
    }
    const taken = keys.find((key) => isCoreSettingsKey(key) || settingOwners.has(key) || key === '__proto__')
    if (taken) {
      refuse(`its project setting ${taken} is a core setting's or another plugin's`)
      continue
    }
    const fieldsProblem = (['repoSettings', 'branchSettings'] as const)
      .map((scope) => {
        const problem = pluginFieldsProblem(manifest[scope])
        return problem ? `its ${scope} ${problem}` : null
      })
      .find((problem) => problem !== null)
    if (fieldsProblem) {
      refuse(fieldsProblem)
      continue
    }
    // Not for this server's platform (plugins E1): listed as unavailable, never set up.
    if (manifest.platforms && !manifest.platforms.includes(platform)) {
      unavailable.push(manifest)
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
    if (instance.ticketProvider && instance.ticketProvider.id !== manifest.id) {
      refuse(`its ticket provider's id ${JSON.stringify(instance.ticketProvider.id)} is not the plugin's id`)
      instance.dispose?.()
      continue
    }
    if (instance.prProvider && instance.prProvider.id !== manifest.id) {
      refuse(`its pull request provider's id ${JSON.stringify(instance.prProvider.id)} is not the plugin's id`)
      instance.dispose?.()
      continue
    }
    const agentRefusal = agentsRefusal(manifest, instance.agentProviders, agentOwners, mcpSuffixes)
    if (agentRefusal) {
      refuse(agentRefusal)
      instance.dispose?.()
      continue
    }
    for (const tool of instance.mcpTools ?? []) toolOwners.set(tool.definition.name, manifest.id)
    for (const key of keys) settingOwners.set(key, manifest.id)
    for (const agent of instance.agentProviders ?? []) {
      agentOwners.set(agent.id, manifest.id)
      if (agent.mcpFile) mcpSuffixes.set(agent.mcpFile.suffix, agent.id)
    }
    entries.set(manifest.id, { manifest, instance })
  }

  const on = (projectId: string): Entry[] => [...entries.values()].filter((e) => enabled(projectId, e.manifest.id))

  const settingRules: PluginSettingRules = {
    kind: (key) => {
      const owner = settingOwners.get(key)
      return owner ? entries.get(owner)?.manifest.projectSettings?.[key] : undefined
    },
    check: (key, value) => {
      const owner = settingOwners.get(key)
      const entry = owner ? entries.get(owner) : undefined
      if (!entry?.instance.checkProjectSetting) return null
      try {
        return entry.instance.checkProjectSetting(key, value)
      } catch (err) {
        return `its check failed: ${err instanceof Error ? err.message : String(err)}`
      }
    },
    knownAgent: (id) => agentOwners.has(id),
    required: (pluginId) => entries.get(pluginId)?.manifest.required === true
  }

  return {
    presence: () => [
      ...[...entries.values()].map((e) => ({ id: e.manifest.id, version: e.manifest.version, defaultEnabled: e.manifest.defaultEnabled, ...(e.manifest.required ? { required: true as const } : {}) })),
      ...unavailable.map((m) => ({ id: m.id, version: m.version, defaultEnabled: m.defaultEnabled, available: false as const }))
    ],
    legacyCapabilities: () => [...entries.values()].flatMap((e) => legacyCapabilitiesOf(e.manifest)),
    handler: (method) => {
      const dot = method.indexOf('.')
      if (dot <= 0) return undefined
      const entry = entries.get(method.slice(0, dot))
      const name = method.slice(dot + 1)
      const handler: PluginHandler | undefined = entry && Object.hasOwn(entry.instance.handlers, name) ? entry.instance.handlers[name] : undefined
      if (!handler) return undefined
      return async (params, caller = '') => {
        const p = params && typeof params === 'object' && !Array.isArray(params) ? (params as Record<string, unknown>) : {}
        try {
          return await handler(p, { ...(typeof p.projectId === 'string' ? { projectId: p.projectId } : {}), caller })
        } catch (err) {
          throw wireError(err)
        }
      }
    },
    enabled,
    connect: (caller, send) => {
      callers.set(caller, send)
      return () => {
        if (callers.get(caller) === send) callers.delete(caller)
      }
    },
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
    ticketProviders: (projectId) => on(projectId).flatMap((e) => (e.instance.ticketProvider ? [e.instance.ticketProvider] : [])),
    prProviders: (projectId) => on(projectId).flatMap((e) => (e.instance.prProvider ? [e.instance.prProvider] : [])),
    lifecycles: () => [...entries.values()].flatMap((e) => (e.instance.worktreeLifecycle ? [{ id: e.manifest.id, lifecycle: e.instance.worktreeLifecycle }] : [])),
    allPrProviders: () => [...entries.values()].flatMap((e) => (e.instance.prProvider ? [e.instance.prProvider] : [])),
    agentProviders: () =>
      [...entries.values()].flatMap((e) =>
        (e.instance.agentProviders ?? []).map((agent) => ({ pluginId: e.manifest.id, projectKeys: Object.keys(e.manifest.projectSettings ?? {}), agent }))
      ),
    settingRules,
    settingFields: (pluginId, scope) => entries.get(pluginId)?.manifest[scope === 'repo' ? 'repoSettings' : 'branchSettings'],
    onChanged: (listener) => {
      changedListeners.push(listener)
    },
    dispose: () => {
      // Each plugin once: after it the registry is empty, and a second dispose does nothing.
      const disposing = [...entries.values()]
      entries.clear()
      unavailable.length = 0
      changedListeners.length = 0
      for (const a of aborts.values()) a.abort()
      aborts.clear()
      for (const e of disposing) {
        try {
          e.instance.dispose?.()
        } catch (err) {
          warn(`[plugin ${e.manifest.id}] dispose failed: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
      // The aborts sent each running program SIGTERM (a spawned one's whole group); SIGKILL follows
      // SPAWN_KILL_GRACE_MS later (run.ts) on an unref'd timer, so the server waits until each is
      // gone or that SIGKILL is sent, or a program ignoring SIGTERM would outlive it (plugins E2).
      const children = [...live]
      if (children.length === 0) return Promise.resolve()
      return new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, PLUGIN_STOP_MS)
        void Promise.all(children).then(() => {
          clearTimeout(timer)
          resolve()
        })
      })
    }
  }
}
