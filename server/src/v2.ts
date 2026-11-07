// Protocol v2 request dispatch. Serves the handshake topics, the repo registry,
// projects, repositories and branch data, worktree commands, session.*, worktree.load/unload
// and the v2 pty.* stream. Attention (working/done) arrives in 2d-2.
import { parseTopic, projectTopic, type Topic } from '../../src/shared/model/topics.ts'
import type { TopicRev } from '../../src/shared/protocolV2'
import type { ConfigStore } from './configStore'
import { codedError, toWireError, type Outcome } from './errors.ts'
import type { Subscriber, TopicHub } from './topicHub'
import { listBranches } from '../../src/host/gitService.ts'
import type { BranchData, Repository } from '../../src/shared/model/types'
import type { GitPoller } from './git/poller.ts'
import { worktreeHandlers } from './worktreeHandlers.ts'
import { sessionHandlers } from './sessionHandlers.ts'
import type { TerminalSink } from './sessions/terminalHost.ts'
import { checkImport } from './projects/importCheck.ts'
import { findRegistered, newRepository, repoIn } from './projects/model.ts'
import type { ProjectState } from './projects/state.ts'
import type { SessionManager } from './sessions/manager.ts'
import { applySettingsPatch, isSettingsKey } from './projects/settings.ts'
import { realOrResolved } from './repos.ts'
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
}

type Handler = (params: any, ctx: V2Context) => unknown

/** A clearable string field: null or "" clears it; anything else must be a string. */
function clearableString(value: unknown, field: string): string | null {
  if (value === null || value === '') return null
  if (typeof value !== 'string') throw codedError('BAD_REQUEST', `${field} must be a string or null`)
  return value
}

const REPO_GUARD_KEYS = ['name', 'linkedDirs', 'environments'] as const

/** Sets or clears one branch-data field; an entry left empty is removed. */
function setBranchField<K extends keyof BranchData>(
  ctx: V2Context,
  p: any,
  field: K,
  value: BranchData[K] | null,
  expected?: unknown
): null {
  const branch = requireBranch(p.branch)
  ctx.projects.apply(p.projectId, (d) => {
    const repo = repoIn(d, p.repoId)
    const data: BranchData = { ...(Object.hasOwn(repo.branchData, branch) ? repo.branchData[branch] : {}) }
    checkExpected(`branchData.${field}`, data[field], expected)
    const empty = value === null || (Array.isArray(value) && value.length === 0)
    if (empty) delete data[field]
    else data[field] = value as BranchData[K]
    if (Object.keys(data).length === 0) delete repo.branchData[branch]
    else repo.branchData[branch] = data
  })
  return null
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
      checkImport(p.project, { registry: ctx.store.config.repos, guard: ctx.store.guard, existingIds, projectId: id })
    )
    return { projectId }
  },

  'project.rename': (p, ctx) => {
    const name = requireName(p.name, 'name')
    ctx.projects.apply(p.projectId, (d) => {
      checkExpected('name', d.name, p.expected)
      d.name = name
    })
    return null
  },

  'project.delete': (p, ctx) => {
    const { id } = ctx.projects.require(p.projectId)
    ctx.projects.delete(id)
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
    ctx.projects.apply(p.projectId, (d) => {
      const current = d.settings as Record<string, unknown>
      for (const [key, value] of Object.entries(expected ?? {})) {
        if (!isSettingsKey(key)) throw codedError('BAD_REQUEST', `expected.${key} is not a project setting`)
        checkExpected(`settings.${key}`, Object.hasOwn(current, key) ? current[key] : undefined, value)
      }
      d.settings = applySettingsPatch(d.settings, patch)
    })
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

  'repo.remove': (p, ctx) => {
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
      if (environments === null) delete repo.environments
      else if (environments !== undefined) repo.environments = environments as Repository['environments']
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
  'branch.setPr': (p, ctx) => setBranchField(ctx, p, 'pr', clearableString(p.pr, 'pr')),
  'branch.setEnv': (p, ctx) => setBranchField(ctx, p, 'env', clearableString(p.env, 'env')),

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

  'server.removeRepo': (p, ctx) => {
    const repoId = requireString(p.repoId, 'repoId')
    // By id only: the CLI's path fallback is not offered over the wire.
    ctx.store.removeRepo(repoId, { idOnly: true })
    return null
  },

  ...worktreeHandlers,
  ...sessionHandlers
}

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

/**
 * Synchronous when the handler is: the caller can then answer in the same tick,
 * so a `sub.subscribe` response always precedes the patches it registered for.
 */
export function dispatchV2(method: string, params: unknown, ctx: V2Context): Outcome | Promise<Outcome> {
  const handler = Object.hasOwn(handlers, method) ? handlers[method] : undefined
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
