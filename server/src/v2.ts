// Protocol v2 request dispatch. Phase 2a serves the handshake topics and the
// repo registry; later sub-plans add the rest of MethodParamsV2.
import { parseTopic } from '../../src/shared/model/topics.ts'
import type { ConfigStore } from './configStore'
import { codedError, toWireError, type Outcome } from './errors.ts'
import type { Subscriber, TopicHub } from './topicHub'

export interface V2Context {
  store: ConfigStore
  hub: TopicHub
  /** This connection, as a topic subscriber */
  subscriber: Subscriber
}

type Handler = (params: any, ctx: V2Context) => unknown

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value === '') throw codedError('BAD_REQUEST', `${field} is required`)
  return value
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw codedError('BAD_REQUEST', `${field} must be a string`)
  return value
}

/** Absent, or a string with something other than whitespace in it. */
function optionalName(value: unknown, field: string): string | undefined {
  const name = optionalString(value, field)
  if (name !== undefined && name.trim() === '') throw codedError('BAD_REQUEST', `${field} must not be empty`)
  return name
}

const handlers: Record<string, Handler> = {
  'sys.ping': (p) => ({ t: p.t }),

  'project.list': () => [],

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
    const path = requireString(p.path, 'path')
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
