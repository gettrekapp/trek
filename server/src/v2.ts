// Protocol v2 request dispatch. Serves the handshake topics, the repo registry,
// projects, repositories and branch data, worktree commands, session.*, worktree.load/unload,
// the v2 pty.* stream, docker, env and stack on the server's machine (machineHandlers.ts), and
// Linear and skills with the server's own key and disk (integrationHandlers.ts), and the
// pull request watch (prWatchHandlers.ts), the Changes tab's review (reviewHandlers.ts), and
// moving a worktree between servers (moveHandlers.ts), and automations (automationHandlers.ts),
// and the server's own update (update/updateHandlers.ts), and the MCP tools a session can call
// (mcp/toolCatalog.ts).
import type { PairingCodes } from './pairing'
import type { PhoneAccessControl } from './phoneAccess'
import { parseTopic, projectTopic, type Topic } from '../../src/shared/model/topics.ts'
import type { IntegrationsChangedEvent, TopicRev } from '../../src/shared/protocolV2'
import type { ConfigStore } from './configStore'
import { codedError, toWireError, type Outcome } from './errors.ts'
import type { Subscriber, TopicHub } from './topicHub'
import { listBranches, normalizeLinkedDir } from '../../src/host/gitService.ts'
import type { BranchData, Repository } from '../../src/shared/model/types'
import { MAX_PLUGIN_TEXT, pluginSettingsShapeProblem, pluginValuesProblem, type PluginSettingValues } from '../../src/shared/plugins/manifest.ts'
import { envRepoValues, LEGACY_ENV_PLUGIN, mirrorBranch, mirrorRepo, repoValuesWithLegacy, setBranchEnv, setRepoEnv } from './projects/legacyEnv.ts'
import type { GitPoller } from './git/poller.ts'
import { worktreeHandlers } from './worktreeHandlers.ts'
import { sessionHandlers } from './sessionHandlers.ts'
import { machineHandlers, type EventSink, type Machine } from './integrations/machineHandlers.ts'
import { integrationHandlers } from './integrations/integrationHandlers.ts'
import { prWatchHandlers } from './prWatch/prWatchHandlers.ts'
import { automationHandlers } from './automations/automationHandlers.ts'
import type { AutomationScheduler } from './automations/scheduler.ts'
import { reviewHandlers } from './review/reviewHandlers.ts'
import { moveHandlers } from './move/moveHandlers.ts'
import { promoteHandlers } from './promote/promoteHandlers.ts'
import { uiHandlers } from './ui/uiHandlers.ts'
import type { UiSelections } from './ui/selections.ts'
import type { UiClientKind } from '../../src/shared/ui.ts'
import { historyHandlers } from './history/historyHandlers.ts'
import type { HistoryStore } from './history/store.ts'
import { updateHandlers } from './update/updateHandlers.ts'
import { pluginInstallHandlers } from './plugins/installHandlers.ts'
import { toolCatalogHandlers, type ToolCatalog } from './mcp/toolCatalog.ts'
import type { InstalledPlugins } from './plugins/installed.ts'
import type { UpdateService } from './update/service.ts'
import { branchChanges, change, recordHistory, tagValue, type Attribution } from './history/record.ts'
import type { PromoteRequests } from './promote/requests.ts'
import type { PrWatcher } from './prWatch/watcher.ts'
import type { Integrations } from './integrations/integrations.ts'
import type { PluginRegistry } from './plugins/registry.ts'
import { participantsFor } from './teardown/participants.ts'
import { repoRemoveVeto } from './teardown/teardown.ts'
import type { TerminalSink } from './sessions/terminalHost.ts'
import { checkImport } from './projects/importCheck.ts'
import { findRegistered, newRepository, repoIn } from './projects/model.ts'
import type { ProjectState } from './projects/state.ts'
import type { SessionManager } from './sessions/manager.ts'
import { DEFAULT_WORKTREE_TAGS, type WorktreeTag } from '../../src/shared/types.ts'
import { applySettingsPatch, isSettingsKey, pruneDeletedTagsReporting, type RemovedTags } from './projects/settings.ts'
import { realOrResolved } from './repos.ts'
import { checkSetGrant, type PushGrants } from './push/grants.ts'
import { LOCAL_TOKEN_NAME } from '../../src/shared/localServer.ts'
import {
  assertNoProtoKeys,
  checkExpected,
  isRecord,
  optionalName,
  optionalStringArray,
  requireAbsolutePath,
  requireName,
  requireBranch,
  requireRecord,
  requireString
} from './validate.ts'

export interface V2Context {
  store: ConfigStore
  hub: TopicHub
  /** This connection, as a topic subscriber */
  subscriber: Subscriber
  projects: ProjectState
  /** Re-reads git after a worktree command */
  poller: GitPoller
  /** Agent sessions and their ptys */
  sessions: SessionManager
  /** This connection, as a receiver of pty events */
  terminal: TerminalSink
  /** The projects' MCP tokens and config files; a deleted project's are revoked */
  mcpAccess?: { revoke(projectId: string): void }
  /** Docker, the environments and the dev stacks on this machine */
  machine?: Machine
  /** This connection, as a receiver of the `docker.log` and `env.log` its own requests stream */
  events?: EventSink
  /** This connection's id for plugins' host.emitTo (plugins E1); absent for a call from no connection (an MCP tool) */
  caller?: string
  /** Linear with the server's own key, and the skills on its disk (phase 5b) */
  integrations?: Integrations
  /** Tells every authenticated connection the Linear key changed (and a plugin's legacy capability, for clients older than plugins) (`integrations.changed`) */
  integrationsChanged?: (parts: IntegrationsChangedEvent) => void
  /** The pull request watch (5c-1): the PR providers' sign-in checks on this machine; without it no PR is watched */
  prWatch?: PrWatcher
  /** Automations' scheduler; without it the automation.* methods that run anything are TOOL_ERROR */
  automations?: AutomationScheduler
  /** promote_to_primary's confirmations (5e): `promote.listen`, `promote.claim`, `promote.answer` and `worktree.promote {requestId}` */
  promoteRequests?: PromoteRequests
  /** What each client shows (`ui.report`), for get_selected_worktree and focus_session */
  selections?: UiSelections
  /** The other MCP servers' tools (`mcpTools.list`); without it only Trek's are listed */
  toolCatalog?: ToolCatalog
  /** This connection's kind of client, as the hello told (absent: a desktop window) */
  clientKind?: UiClientKind
  /** Where a promote or demote saves a copy of the work it carries (5e; default: the temp dir) */
  promoteRecoveryDir?: string
  /** Phone pairing's one-time codes (6a) */
  pairing?: PairingCodes
  /** The local server's listener for phones (`phoneAccess.*`); absent on any other server */
  phoneAccess?: PhoneAccessControl
  /** The name of the token this connection signed in with (a web session's token, for a browser) */
  tokenName?: string
  /** The local server's shutdown (`server.stop`); absent on any other server */
  requestStop?: () => void
  /** Background push (6b): each token's relay grant */
  push?: { grants: PushGrants }
  /** The server's plugins (plugin system phase 1): a method no core handler has goes to plugin `<id>` */
  plugins?: PluginRegistry
  /** The installed plugins (theme plugins phase 1): `plugins.install`, `plugins.remove`, `plugins.bundle` */
  installed?: { store: Pick<InstalledPlugins, 'add' | 'remove' | 'bundle'>; remoteInstall: () => boolean; fetch: typeof fetch; /** Where an install or a removal is logged (default: console.log) */ log?: (line: string) => void }
  /** The worktree history; without it nothing is recorded and history.list is empty */
  history?: HistoryStore
  /** The server's update service (the `update` capability); absent on a server that cannot update itself */
  update?: Pick<UpdateService, 'status' | 'check' | 'apply'>
  /** Who this request acts as, for the history: absent is a Trek client's user; the MCP tool caller sets `mcp` */
  attribution?: Attribution
}

type Handler = (params: any, ctx: V2Context) => unknown

function pushGrantsOf(ctx: V2Context): PushGrants {
  if (!ctx.push) throw codedError('NOT_FOUND', 'This server does not push')
  if (!ctx.tokenName) throw codedError('BAD_REQUEST', 'push grants belong to a token')
  return ctx.push.grants
}

/**
 * `phoneAccess.*`: the local server only, and only the app's own connection (the `local` token), so
 * a phone's UI can't change the listener or revoke another phone. A guard rail, not a boundary:
 * any token on the local server can already start a shell there (and so read local.json or edit
 * the config).
 */
function phoneControlOf(ctx: V2Context): PhoneAccessControl {
  if (!ctx.phoneAccess) throw codedError('NOT_FOUND', 'Only the local server has phone access')
  if (ctx.tokenName !== LOCAL_TOKEN_NAME) throw codedError('UNAUTHORIZED', `Only the "${LOCAL_TOKEN_NAME}" token may change the local server's phone access`)
  return ctx.phoneAccess
}

/** A clearable string field: null or "" clears it; anything else must be a string. */
function clearableString(value: unknown, field: string): string | null {
  if (value === null || value === '') return null
  if (typeof value !== 'string') throw codedError('BAD_REQUEST', `${field} must be a string or null`)
  return value
}

const REPO_GUARD_KEYS = ['name', 'linkedDirs', 'environments'] as const

/** Sets or clears one branch-data field; an entry left empty is removed. The change goes in the history. */
function setBranchField<K extends keyof BranchData>(
  ctx: V2Context,
  p: any,
  field: K,
  value: BranchData[K] | null,
  expected?: unknown
): null {
  const branch = requireBranch(p.branch)
  const { repoId, changes } = ctx.projects.apply(p.projectId, (d) => {
    const repo = repoIn(d, p.repoId)
    const data: BranchData = { ...(Object.hasOwn(repo.branchData, branch) ? repo.branchData[branch] : {}) }
    checkExpected(`branchData.${field}`, data[field], expected)
    const before = data[field]
    const empty = value === null || (Array.isArray(value) && value.length === 0)
    if (empty) delete data[field]
    else data[field] = value as BranchData[K]
    if (Object.keys(data).length === 0) delete repo.branchData[branch]
    else repo.branchData[branch] = data
    return { repoId: repo.id, changes: branchChanges(field, before, data[field], d.settings) }
  })
  recordHistory(ctx, requireString(p.projectId, 'projectId'), repoId, branch, changes)
  return null
}

/**
 * `repo.setPluginSettings` / `branch.setPluginSettings` (plugins E1): the plugin and its values,
 * checked against its manifest. Only a plugin set up on this server has `settingFields`: one
 * registered for another platform (listed `available: false`) is refused here, though
 * `project.import` and `move.receive` keep its values by shape (pluginSettingsShapeProblem), so
 * nothing is lost when the project moves to a server where it runs.
 */
function pluginSettingsOf(
  ctx: V2Context,
  p: any,
  scope: 'repo' | 'branch'
): { pluginId: string; values: PluginSettingValues; expected: Record<string, unknown> | null | undefined } {
  const pluginId = requireString(p.pluginId, 'pluginId')
  const fields = ctx.plugins?.settingFields(pluginId, scope)
  if (!fields) throw codedError('BAD_REQUEST', `no plugin ${JSON.stringify(pluginId)} on this server has ${scope} settings`)
  // A plain object (not an array, not null): pluginValuesProblem reads its own entries.
  const values = requireRecord(p.values, 'values')
  assertNoProtoKeys(values, 'values')
  const problem = pluginValuesProblem(fields, values)
  if (problem) throw codedError('BAD_REQUEST', `values.${problem}`)
  // `expected` (plugins E3): absent, no check; null, none stored; else the plugin's values as read.
  const expected = p.expected === undefined || p.expected === null ? p.expected : requireRecord(p.expected, 'expected')
  return { pluginId, values: values as PluginSettingValues, expected }
}

/**
 * A plugin's own entry in a stored pluginSettings map (an own key only), for `expected` (plugins E3).
 * For `env` this is the plugin's copy, not its old name: every write to either keeps the mirror made
 * from it (legacyEnv.ts), so a change the old name shows changes this entry too, and a change only
 * this entry shows (a plugin-only key) is one repo.update keeps.
 */
function ownPluginValues(map: Record<string, PluginSettingValues> | undefined, pluginId: string): PluginSettingValues | undefined {
  return map && Object.hasOwn(map, pluginId) ? map[pluginId] : undefined
}

/**
 * A pluginSettings map with one plugin's entry set (or, with no values, removed); undefined when
 * that leaves it empty. BAD_REQUEST, inside the caller's apply so nothing is kept, when the map
 * would be one a move or an import refuses (over 1 MB of text in all, say).
 */
function withPluginValues(map: Record<string, PluginSettingValues> | undefined, pluginId: string, values: PluginSettingValues): Record<string, PluginSettingValues> | undefined {
  const next = { ...(map ?? {}) }
  if (Object.keys(values).length === 0) delete next[pluginId]
  else next[pluginId] = { ...values }
  const problem = pluginSettingsShapeProblem(next)
  if (problem) throw codedError('BAD_REQUEST', `pluginSettings ${problem}`)
  return Object.keys(next).length > 0 ? next : undefined
}

const handlers: Record<string, Handler> = {
  'sys.ping': (p) => ({ t: p.t }),

  'project.list': (_p, ctx) => ctx.projects.list(),

  'project.create': (p, ctx) => {
    const name = requireName(p.name, 'name')
    if (!Array.isArray(p.repositories) || p.repositories.length === 0) {
      throw codedError('BAD_REQUEST', 'repositories must be a non-empty array')
    }
    const repositories = p.repositories.map((r: unknown, i: number) => {
      if (!isRecord(r)) throw codedError('BAD_REQUEST', `repositories[${i}] must be an object`)
      return {
        registered: findRegistered(ctx.store.config.repos, requireString(r.path, `repositories[${i}].path`)),
        name: optionalName(r.name, `repositories[${i}].name`)
      }
    })
    if (new Set(repositories.map((r: { registered: { id: string } }) => r.registered.id)).size !== repositories.length) {
      throw codedError('BAD_REQUEST', 'a repository is listed twice')
    }
    return { projectId: ctx.projects.create(name, repositories) }
  },

  'project.import': (p, ctx) => {
    const existingIds = ctx.projects.allIds()
    const projectId = ctx.projects.importProject((id) =>
      checkImport(p.project, { registry: ctx.store.config.repos, guard: ctx.store.guard, existingIds, projectId: id, settingRules: ctx.plugins?.settingRules })
    )
    return { projectId }
  },

  'project.rename': (p, ctx) => {
    const name = requireName(p.name, 'name')
    ctx.projects.apply(p.projectId, (d) => {
      checkExpected('name', d.name, p.expected)
      d.name = name
    })
    // The attention topic carries the project's name.
    ctx.sessions.refreshAttention()
    return null
  },

  'project.delete': (p, ctx) => {
    const { id } = ctx.projects.require(p.projectId)
    ctx.projects.delete(id)
    ctx.history?.dropProject(id)
    // Only once the project is gone: a delete that fails leaves its sessions running.
    // The manager tracks its ptys itself, so the records are not needed for this.
    ctx.sessions.forgetProject(id)
    try {
      ctx.mcpAccess?.revoke(id)
    } catch (err) {
      // The project is already gone; a leftover config file is cleared on the next start.
      console.warn(`[mcp] could not revoke access for deleted project ${id}: ${(err as Error).message}`)
    }
    return null
  },

  'project.updateSettings': (p, ctx) => {
    const patch = requireRecord(p.settings, 'settings')
    const expected = p.expected === undefined ? undefined : requireRecord(p.expected, 'expected')
    let removed: RemovedTags[] = []
    let oldTags: WorktreeTag[] | undefined
    let oldCustom: WorktreeTag[] | undefined
    ctx.projects.apply(p.projectId, (d) => {
      const current = d.settings as Record<string, unknown>
      oldTags = d.settings.worktreeTags ?? DEFAULT_WORKTREE_TAGS
      oldCustom = d.settings.customTags
      for (const [key, value] of Object.entries(expected ?? {})) {
        if (!isSettingsKey(key, ctx.plugins?.settingRules)) throw codedError('BAD_REQUEST', `expected.${key} is not a project setting`)
        checkExpected(`settings.${key}`, Object.hasOwn(current, key) ? current[key] : undefined, value)
      }
      d.settings = applySettingsPatch(d.settings, patch, ctx.plugins?.settingRules)
      // A deleted tag comes off every branch in the same change (one patch, one rev).
      const pruned = pruneDeletedTagsReporting(d.repositories, d.settings, patch)
      d.repositories = pruned.repositories
      removed = pruned.removed
    })
    for (const r of removed) {
      recordHistory(ctx, p.projectId as string, r.repoId, r.branch, [
        ...(r.tag ? [change('status', tagValue(oldTags, r.tag))] : []),
        ...r.customTags.map((id) => change('label.removed', tagValue(oldCustom, id)))
      ])
    }
    // The attention topic carries the project's audioAlerts.
    ctx.sessions.refreshAttention()
    return null
  },

  'repo.add': (p, ctx) => {
    const registered = findRegistered(ctx.store.config.repos, requireString(p.path, 'path'))
    const name = optionalName(p.name, 'name')
    const repoId = ctx.projects.apply(p.projectId, (d) => {
      const target = realOrResolved(registered.path)
      if (d.repositories.some((r) => realOrResolved(r.path) === target)) {
        throw codedError('BAD_REQUEST', `${registered.path} is already in this project`)
      }
      const repo = newRepository(registered, name, ctx.projects.newId)
      d.repositories.push(repo)
      return repo.id
    })
    return { repoId }
  },

  'repo.remove': async (p, ctx) => {
    const current = ctx.projects.require(p.projectId)
    const target = repoIn(current, p.repoId)
    // What runs for its worktrees on the server's machine may stop it (plugins E1: a running VM).
    // Asked only when it is not the last repository, whose own refusal comes first.
    if (current.repositories.length > 1) {
      const veto = await repoRemoveVeto(participantsFor(ctx, current.id), current, target)
      if (veto) throw codedError('BAD_REQUEST', veto)
    }
    const { projectId, repoId } = ctx.projects.apply(p.projectId, (d) => {
      const repo = repoIn(d, p.repoId)
      if (d.repositories.length === 1) throw codedError('BAD_REQUEST', 'a project needs at least one repository')
      d.repositories = d.repositories.filter((r) => r !== repo)
      if (d.settings.worktreeOrder) {
        const order = d.settings.worktreeOrder.filter((key) => !key.startsWith(`${repo.id} `))
        if (order.length > 0) d.settings.worktreeOrder = order
        else delete d.settings.worktreeOrder
      }
      return { projectId: d.id, repoId: repo.id }
    })
    ctx.history?.dropRepo(projectId, repoId)
    // Only once the repository is removed: a refused remove ends none of its sessions.
    ctx.sessions.forgetRepo(projectId, repoId)
    // Global sessions run in the first repository with the others as additional
    // directories, so every removal leaves the running ones with a stale set.
    ctx.sessions.forgetGlobal(projectId)
    return null
  },

  'repo.update': (p, ctx) => {
    const name = optionalName(p.name, 'name')
    const linkedDirs = p.linkedDirs === null ? null : optionalStringArray(p.linkedDirs, 'linkedDirs')
    // Each must name a path inside the repository, as linkDirs and a move's export read it.
    linkedDirs?.forEach((entry, i) => {
      if (normalizeLinkedDir(entry) === null) {
        throw codedError('BAD_REQUEST', `linkedDirs[${i}] must be a relative path inside the repository (not empty, ".", absolute or with "..")`)
      }
    })
    const environments = p.environments === null || p.environments === undefined ? p.environments : requireRecord(p.environments, 'environments')
    if (environments) assertNoProtoKeys(environments, 'environments')
    const expected = p.expected === undefined ? {} : requireRecord(p.expected, 'expected')
    for (const key of Object.keys(expected)) {
      if (!(REPO_GUARD_KEYS as readonly string[]).includes(key)) {
        throw codedError('BAD_REQUEST', `expected.${key} must be one of ${REPO_GUARD_KEYS.join(', ')}`)
      }
    }
    ctx.projects.apply(p.projectId, (d) => {
      const repo = repoIn(d, p.repoId)
      for (const key of REPO_GUARD_KEYS) {
        if (Object.hasOwn(expected, key)) checkExpected(key, repo[key], expected[key])
      }
      if (name !== undefined) repo.name = name
      if (linkedDirs === null) delete repo.linkedDirs
      else if (linkedDirs !== undefined) repo.linkedDirs = linkedDirs
      // The env plugin's settings under their old name (plugins E2): both are written (legacyEnv.ts),
      // the plugin's fields only, each of the right kind. A value the old field cannot hold (a
      // plugin-only key) is kept, by `environments: null` too, which clears only the old field's.
      if (environments !== undefined) {
        const problem = setRepoEnv(repo, repoValuesWithLegacy(envRepoValues(repo.pluginSettings), environments ?? {}))
        if (problem) throw codedError('BAD_REQUEST', `pluginSettings ${problem}`)
      }
    })
    return null
  },

  // A plugin's per-repository settings (plugins E1): `values` replaces the plugin's own; {} clears them.
  // `expected` (plugins E3): a compare-and-set on the plugin's own values.
  'repo.setPluginSettings': (p, ctx) => {
    const { pluginId, values, expected } = pluginSettingsOf(ctx, p, 'repo')
    ctx.projects.apply(p.projectId, (d) => {
      const repo = repoIn(d, p.repoId)
      checkExpected(`pluginSettings.${pluginId}`, ownPluginValues(repo.pluginSettings, pluginId), expected)
      const next = withPluginValues(repo.pluginSettings, pluginId, values)
      if (next) repo.pluginSettings = next
      else delete repo.pluginSettings
      // Its old name too (plugins E2, legacyEnv.ts).
      if (pluginId === LEGACY_ENV_PLUGIN) mirrorRepo(repo)
    })
    return null
  },

  'repo.listBranches': async (p, ctx) => {
    const repo = repoIn(ctx.projects.require(p.projectId), p.repoId)
    try {
      return await listBranches(repo.path)
    } catch (err) {
      throw codedError('GIT_ERROR', (err as Error).message)
    }
  },

  'branch.setTag': (p, ctx) => setBranchField(ctx, p, 'tag', clearableString(p.tag, 'tag')),
  'branch.setCustomTags': (p, ctx) => {
    if (p.customTags === undefined) throw codedError('BAD_REQUEST', 'customTags is required')
    // null or [] clears; setBranchField drops an empty array.
    const tags = p.customTags === null ? null : optionalStringArray(p.customTags, 'customTags')!
    return setBranchField(ctx, p, 'customTags', tags)
  },
  'branch.setNote': (p, ctx) => setBranchField(ctx, p, 'note', clearableString(p.note, 'note'), p.expected),
  'branch.setTicket': (p, ctx) => setBranchField(ctx, p, 'ticket', clearableString(p.ticket, 'ticket')),
  // A different PR (or none) ends the branch's watch: it watched the old one (5c-1).
  'branch.setPr': (p, ctx) => {
    const pr = clearableString(p.pr, 'pr')
    const branch = requireBranch(p.branch)
    const { ended, repoId, changes } = ctx.projects.apply(p.projectId, (d) => {
      const repo = repoIn(d, p.repoId)
      const data: BranchData = { ...(Object.hasOwn(repo.branchData, branch) ? repo.branchData[branch] : {}) }
      const before = data.pr
      if (pr === null) delete data.pr
      else data.pr = pr
      let ended: string | undefined
      const changes = branchChanges('pr', before, data.pr, d.settings)
      if (data.prWatch && repo.branchData[branch]?.pr !== pr) {
        delete data.prWatch
        ended = repo.id
        changes.push({ kind: 'prWatch.off' })
      }
      if (Object.keys(data).length === 0) delete repo.branchData[branch]
      else repo.branchData[branch] = data
      return { ended, repoId: repo.id, changes }
    })
    const projectId = requireString(p.projectId, 'projectId')
    recordHistory(ctx, projectId, repoId, branch, changes)
    if (ended !== undefined) ctx.prWatch?.forget(projectId, ended, branch)
    return null
  },
  // The env plugin's branch setting under its old name (plugins E2): both are written (legacyEnv.ts),
  // held to the plugin's limits. No history is recorded, as before.
  'branch.setEnv': (p, ctx) => {
    const env = clearableString(p.env, 'env')
    if (env !== null && env.length > MAX_PLUGIN_TEXT) throw codedError('BAD_REQUEST', `env must be at most ${MAX_PLUGIN_TEXT} characters`)
    const branch = requireBranch(p.branch)
    ctx.projects.apply(p.projectId, (d) => {
      const repo = repoIn(d, p.repoId)
      const data: BranchData = { ...(Object.hasOwn(repo.branchData, branch) ? repo.branchData[branch] : {}) }
      checkExpected('branchData.env', data.env, p.expected)
      const problem = setBranchEnv(data, env)
      if (problem) throw codedError('BAD_REQUEST', `pluginSettings ${problem}`)
      if (Object.keys(data).length === 0) delete repo.branchData[branch]
      else repo.branchData[branch] = data
    })
    return null
  },
  // A plugin's per-branch settings (plugins E1), kept with the branch's data: they outlive the worktree and move with it.
  // No history is recorded, as for setEnv. `expected` (plugins E3): a compare-and-set on the plugin's own values.
  'branch.setPluginSettings': (p, ctx) => {
    const { pluginId, values, expected } = pluginSettingsOf(ctx, p, 'branch')
    const branch = requireBranch(p.branch)
    ctx.projects.apply(p.projectId, (d) => {
      const repo = repoIn(d, p.repoId)
      const data: BranchData = { ...(Object.hasOwn(repo.branchData, branch) ? repo.branchData[branch] : {}) }
      checkExpected(`pluginSettings.${pluginId}`, ownPluginValues(data.pluginSettings, pluginId), expected)
      const next = withPluginValues(data.pluginSettings, pluginId, values)
      if (next) data.pluginSettings = next
      else delete data.pluginSettings
      // Its old name too (plugins E2, legacyEnv.ts).
      if (pluginId === LEGACY_ENV_PLUGIN) mirrorBranch(data)
      if (Object.keys(data).length === 0) delete repo.branchData[branch]
      else repo.branchData[branch] = data
    })
    return null
  },

  'sub.subscribe': (p, ctx) => {
    if (!parseTopic(p.topic)) throw codedError('BAD_REQUEST', `Unknown topic: ${String(p.topic)}`)
    const state = ctx.hub.subscribe(p.topic, ctx.subscriber)
    if (!state) throw codedError('NOT_FOUND', `No such topic: ${p.topic}`)
    return state
  },

  'sub.unsubscribe': (p, ctx) => {
    ctx.hub.unsubscribe(p.topic, ctx.subscriber)
    return null
  },

  'server.addRepo': (p, ctx) => {
    const path = requireAbsolutePath(p.path, 'path')
    const name = optionalName(p.name, 'name')
    const { repo } = ctx.store.addRepo(path, { name, requireAllowedRoot: true })
    return { repoId: repo.id }
  },

  // `trek-server stop --local` (Windows has no SIGTERM: a signal there is TerminateProcess, so the
  // shutdown that saves projects and removes local.json would never run). Only the local server,
  // and only its own `local` token, the one in local.json: a phone, web or other token may not.
  'server.stop': (_p, ctx) => {
    if (!ctx.requestStop) throw codedError('NOT_FOUND', 'Only the local server stops over the wire; stop this one where it runs')
    if (ctx.tokenName !== LOCAL_TOKEN_NAME) throw codedError('UNAUTHORIZED', `Only the "${LOCAL_TOKEN_NAME}" token may stop the local server`)
    ctx.requestStop()
    return null
  },

  'server.removeRepo': (p, ctx) => {
    const repoId = requireString(p.repoId, 'repoId')
    // By id only: the CLI's path fallback is not offered over the wire.
    ctx.store.removeRepo(repoId, { idOnly: true })
    return null
  },

  ...worktreeHandlers,
  ...sessionHandlers,
  ...machineHandlers,
  ...integrationHandlers,
  ...prWatchHandlers,
  ...automationHandlers,
  ...reviewHandlers,
  ...moveHandlers,
  ...promoteHandlers,
  ...uiHandlers,
  ...historyHandlers,
  ...updateHandlers,
  ...pluginInstallHandlers,
  ...toolCatalogHandlers,

  // A one-time code a phone redeems at hello for its own token (6a). Any signed-in connection may
  // ask (a web session or a paired phone included): a token already holds shell-level power on
  // this machine. The caller's token name is recorded as the phone token's pairedBy. Only the
  // code's hash is kept.
  'pairing.create': (p, ctx) => {
    if (!ctx.pairing) throw codedError('NOT_FOUND', 'This server does not pair phones')
    if (p.name !== undefined && typeof p.name !== 'string') throw codedError('BAD_REQUEST', 'name must be a string')
    return ctx.pairing.create(((p.name as string | undefined) ?? '').trim(), Date.now(), ctx.tokenName ?? '')
  },

  // Background push (6b): the calling token's relay grant. Write-only: status never returns the secret.
  'push.setGrant': (p, ctx) => {
    const grants = pushGrantsOf(ctx)
    grants.set(ctx.tokenName!, checkSetGrant(p))
    return null
  },
  'push.clearGrant': (_p, ctx) => {
    pushGrantsOf(ctx).clear(ctx.tokenName!)
    return null
  },
  'push.status': (_p, ctx) => pushGrantsOf(ctx).status(ctx.tokenName!),

  // Drops a waiting code. Any signed-in connection that knows the code may: whoever holds it
  // could redeem it, which is more.
  'pairing.cancel': (p, ctx) => {
    if (!ctx.pairing) throw codedError('NOT_FOUND', 'This server does not pair phones')
    if (typeof p.code !== 'string' || p.code.length > 64) throw codedError('BAD_REQUEST', 'code must be a string')
    return { cancelled: ctx.pairing.cancel(p.code, Date.now()) }
  },

  // The local server's listener for phones, on this machine's Tailscale address.
  'phoneAccess.get': (_p, ctx) => phoneControlOf(ctx).status(),
  'phoneAccess.set': (p, ctx) => phoneControlOf(ctx).set(p),
  'phoneAccess.revoke': (p, ctx) => ({ revoked: phoneControlOf(ctx).revoke(p.name) })
}

/** The branch-data setters (the history's coverage test checks each records its change) */
export const BRANCH_SET_METHODS: readonly string[] = Object.keys(handlers).filter((m) => m.startsWith('branch.set'))

/** Commands that change the `server` topic (the project list or the repo registry): their responses report its rev. */
const SERVER_TOPIC_METHODS: ReadonlySet<string> = new Set([
  'project.create',
  'project.import',
  'project.delete',
  'server.addRepo',
  'server.removeRepo'
])

/**
 * The rev a successful response reports (PROTOCOL.md, "Revs"): the `server` topic's for
 * the commands above, else the project topic's for a method whose params name a project
 * that still has one. Read once the handler is done, so it covers every change it made.
 */
export function responseRev(method: string, params: unknown, hub: TopicHub): TopicRev | undefined {
  let topic: Topic | undefined
  if (SERVER_TOPIC_METHODS.has(method)) topic = 'server'
  else if (isRecord(params) && typeof params.projectId === 'string') topic = projectTopic(params.projectId)
  if (!topic) return undefined
  const rev = hub.rev(topic)
  return rev === undefined ? undefined : { topic, rev }
}

/** Whether a core method's name starts with `prefix` (a plugin may not take a core namespace). */
export function isCoreMethod(prefix: string): boolean {
  return Object.keys(handlers).some((name) => name.startsWith(prefix))
}

/** A plugin's method (`<id>.<name>`), when no core method has the name. */
function pluginHandler(method: string, ctx: V2Context): Handler | undefined {
  const call = ctx.plugins?.handler(method)
  return call ? (params) => call(params, ctx.caller) : undefined
}

/**
 * Synchronous when the handler is: the caller can then answer in the same tick,
 * so a `sub.subscribe` response always precedes the patches it registered for.
 */
export function dispatchV2(method: string, params: unknown, ctx: V2Context): Outcome | Promise<Outcome> {
  const handler = Object.hasOwn(handlers, method) ? handlers[method] : pluginHandler(method, ctx)
  if (!handler) {
    return { ok: false, error: { code: 'NOT_FOUND', message: `Unknown method: ${method}` } }
  }
  let result: unknown
  try {
    result = handler(params ?? {}, ctx)
  } catch (err) {
    return { ok: false, error: toWireError(method, err) }
  }
  if (result instanceof Promise) {
    return result.then(
      (value): Outcome => ({ ok: true, result: value }),
      (err): Outcome => ({ ok: false, error: toWireError(method, err) })
    )
  }
  return { ok: true, result }
}
