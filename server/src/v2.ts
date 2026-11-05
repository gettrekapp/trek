// Protocol v2 request dispatch. Phase 2a serves the handshake topics and the
// repo registry; later sub-plans add the rest of MethodParamsV2.
import { parseTopic } from '../../src/shared/model/topics.ts'
import type { ConfigStore } from './configStore'
import { codedError, toWireError, type Outcome } from './errors.ts'
import type { Subscriber, TopicHub } from './topicHub'
import { listBranches } from '../../src/host/gitService.ts'
import type { BranchData, Project, Repository } from '../../src/shared/model/types'
import { checkImport } from './projects/importCheck.ts'
import { findRegistered, newRepository } from './projects/model.ts'
import type { ProjectState } from './projects/state.ts'
import { applySettingsPatch } from './projects/settings.ts'
import {
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
}

type Handler = (params: any, ctx: V2Context) => unknown

function repoIn(project: Project, repoId: unknown): Repository {
  const repo = project.repositories.find((r) => r.id === repoId)
  if (!repo) throw codedError('NOT_FOUND', `No repository with id "${String(repoId)}" in this project`)
  return repo
}

/** A nullable string field: null clears it; anything else must be a string. */
function nullableString(value: unknown, field: string): string | null {
  if (value === null) return null
  if (typeof value !== 'string') throw codedError('BAD_REQUEST', `${field} must be a string or null`)
  return value
}

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
    ctx.projects.delete(p.projectId)
    return null
  },

  'project.updateSettings': (p, ctx) => {
    const patch = requireRecord(p.settings, 'settings')
    const expected = p.expected === undefined ? undefined : requireRecord(p.expected, 'expected')
    ctx.projects.apply(p.projectId, (d) => {
      const current = d.settings as Record<string, unknown>
      for (const [key, value] of Object.entries(expected ?? {})) checkExpected(`settings.${key}`, current[key], value)
      d.settings = applySettingsPatch(d.settings, patch)
    })
    return null
  },

  'repo.add': (p, ctx) => {
    const registered = findRegistered(ctx.store.config.repos, requireString(p.path, 'path'))
    const name = optionalName(p.name, 'name')
    const repoId = ctx.projects.apply(p.projectId, (d) => {
      if (d.repositories.some((r) => r.path === registered.path)) {
        throw codedError('BAD_REQUEST', `${registered.path} is already in this project`)
      }
      const repo = newRepository(registered, name, ctx.projects.newId)
      d.repositories.push(repo)
      return repo.id
    })
    return { repoId }
  },

  'repo.remove': (p, ctx) => {
    ctx.projects.apply(p.projectId, (d) => {
      const repo = repoIn(d, p.repoId)
      if (d.repositories.length === 1) throw codedError('BAD_REQUEST', 'a project needs at least one repository')
      d.repositories = d.repositories.filter((r) => r !== repo)
      if (d.settings.worktreeOrder) {
        const order = d.settings.worktreeOrder.filter((key) => !key.startsWith(`${repo.id} `))
        if (order.length > 0) d.settings.worktreeOrder = order
        else delete d.settings.worktreeOrder
      }
    })
    return null
  },

  'repo.update': (p, ctx) => {
    const name = optionalName(p.name, 'name')
    const linkedDirs = p.linkedDirs === null ? null : optionalStringArray(p.linkedDirs, 'linkedDirs')
    const environments = p.environments === null || p.environments === undefined ? p.environments : requireRecord(p.environments, 'environments')
    const expected = p.expected === undefined ? {} : requireRecord(p.expected, 'expected')
    ctx.projects.apply(p.projectId, (d) => {
      const repo = repoIn(d, p.repoId)
      for (const key of ['name', 'linkedDirs', 'environments'] as const) {
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

  'branch.setTag': (p, ctx) => setBranchField(ctx, p, 'tag', nullableString(p.tag, 'tag')),
  'branch.setCustomTags': (p, ctx) => {
    const tags = optionalStringArray(p.customTags, 'customTags')
    if (tags === undefined) throw codedError('BAD_REQUEST', 'customTags is required')
    return setBranchField(ctx, p, 'customTags', tags)
  },
  'branch.setNote': (p, ctx) => setBranchField(ctx, p, 'note', nullableString(p.note, 'note'), p.expected),
  'branch.setTicket': (p, ctx) => setBranchField(ctx, p, 'ticket', nullableString(p.ticket, 'ticket')),
  'branch.setPr': (p, ctx) => setBranchField(ctx, p, 'pr', nullableString(p.pr, 'pr')),
  'branch.setEnv': (p, ctx) => setBranchField(ctx, p, 'env', nullableString(p.env, 'env')),

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
  }
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
