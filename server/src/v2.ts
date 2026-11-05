// Protocol v2 request dispatch. Phase 2a serves the handshake topics and the
// repo registry; later sub-plans add the rest of MethodParamsV2.
import { parseTopic } from '../../src/shared/model/topics.ts'
import type { ConfigStore } from './configStore'
import { codedError, toWireError, type Outcome } from './errors.ts'
import type { Subscriber, TopicHub } from './topicHub'
import { checkImport } from './projects/importCheck.ts'
import { findRegistered } from './projects/model.ts'
import type { ProjectState } from './projects/state.ts'
import { applySettingsPatch } from './projects/settings.ts'
import {
  checkExpected,
  isRecord,
  optionalName,
  requireAbsolutePath,
  requireName,
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
